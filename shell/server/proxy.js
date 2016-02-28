// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2014 Sandstorm Development Group, Inc. and contributors
// All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

const Crypto = Npm.require("crypto");
const ChildProcess = Npm.require("child_process");
const Fs = Npm.require("fs");
const Path = Npm.require("path");
const Future = Npm.require("fibers/future");
const Http = Npm.require("http");
const Url = Npm.require("url");
const Promise = Npm.require("es6-promise").Promise;
const Capnp = Npm.require("capnp");
const Net = Npm.require("net");

const ByteStream = Capnp.importSystem("sandstorm/util.capnp").ByteStream;
const ApiSession = Capnp.importSystem("sandstorm/api-session.capnp").ApiSession;
const WebSession = Capnp.importSystem("sandstorm/web-session.capnp").WebSession;
const HackSession = Capnp.importSystem("sandstorm/hack-session.capnp");
const Supervisor = Capnp.importSystem("sandstorm/supervisor.capnp").Supervisor;
const Backend = Capnp.importSystem("sandstorm/backend.capnp").Backend;

SANDSTORM_ALTHOME = Meteor.settings && Meteor.settings.home;
SANDSTORM_LOGDIR = (SANDSTORM_ALTHOME || "") + "/var/log";
SANDSTORM_VARDIR = (SANDSTORM_ALTHOME || "") + "/var/sandstorm";

const storeReferralProgramInfoApiTokenCreated = (db, accountId, identityId, apiTokenAccountId) => {
  // From the Referral program's perspective, if Bob's Account has no referredByComplete, then we
  // update Bob's Identity to say it's referredBy Alice's Account (which is apiTokenAccountId).
  check(accountId, String);
  check(identityId, String);
  check(apiTokenAccountId, String);

  // Bail out early if quota enforcement is disabled.
  if (!Meteor.settings.public.quotaEnabled) {
    return;
  }

  const aliceAccountId = apiTokenAccountId;
  const bobAccountId = accountId;
  const bobIdentityId = identityId;

  if (Meteor.users.find({
    _id: bobAccountId,
    referredByComplete: { $exists: true },
  }).count() > 0) {
    return;
  }

  // Only actually update Bob's Identity ID if there is no referredBy.
  Meteor.users.update(
    { _id: bobIdentityId, referredBy: { $exists: false } },
    { $set: { referredBy: aliceAccountId } });
};

function referralProgramLogSharingTokenUse(db, bobAccountId) {
  // Hooray! The sharing token is valid! Someone (let's call them Charlie) is going to get a UiView
  // to this grain!  This means that the user who created this apiToken knows how to use the 'share
  // access' interface. Let's call them Bob.
  //
  // If Bob's Account.referredByComplete is not yet set, then look at Bob's Identities and take the
  // first referredBy we find -- let's call that Alice.
  //
  // We copy Alice's account ID to Bob's Account.referredByComplete, and then update Alice's
  // referredIdentityIds to point at Bob's Identity, and then remove the referredBy from Bob's
  // Identity since it has become redundant.
  //
  // Implementation note: this does mean that Alice can get referral credit for Bob by sharing a
  // link with Bob, even if Bob already had an account.

  // Bail out early if quota support is not enabled.
  if (!Meteor.settings.public.quotaEnabled) {
    return;
  }

  // Bail out if Bob has a referredByComplete.
  if (Meteor.users.find({ _id: bobAccountId, referredByComplete: { $exists: true } }).count() > 0) {
    return;
  }

  // Look for a referredBy on any of Bob's identities.
  const bobIdentityIds = SandstormDb.getUserIdentityIds(Meteor.users.findOne({ _id: bobAccountId }));
  const bobIdentityWithReferredBy = Meteor.users.findOne({
    _id: { $in: bobIdentityIds },
    referredBy: { $exists: true },
  });

  if (!bobIdentityWithReferredBy) {
    return;
  }

  const aliceAccountId = bobIdentityWithReferredBy.referredBy;

  // Store Bob's Account.referralCompletedBy.
  const now = new Date();
  Meteor.users.update({
    _id: bobAccountId,
    referredByComplete: { $exists: false },
  }, {
    $set: {
      referredByComplete: bobIdentityWithReferredBy.referredBy,
      referredCompleteDate: now,
    },
  });

  // Update Alice's Account.referredIdentityIds.
  Meteor.users.update({ _id: aliceAccountId }, {
    $push: { referredIdentityIds: bobIdentityWithReferredBy._id },
  });

  // Remove now-redundant Bob identity referredBy.
  Meteor.users.update({ _id: bobIdentityWithReferredBy._id }, {
    $unset: { referredBy: true },
  });
}

// User-agent strings that should be allowed to use http basic authentication.
// These are regex matches, so ensure they are escaped properly with double
// backslashes. For security reasons, we MUST NOT whitelist any user-agents
// that may render html and execute embedded scripts.
BASIC_AUTH_USER_AGENTS = [
  "git\\/",
  "GitHub-Hookshot\\/",
  "mirall\\/",
  "Mozilla\\/5\\.0 \\([^\\\\]*\\) mirall\\/",
  "Mozilla\\/5\\.0 \\(iOS\\) ownCloud-iOS\\/",
  "Mozilla\\/5\\.0 \\(Android\\) ownCloud-android\\/",
  "litmus\\/",
];
BASIC_AUTH_USER_AGENTS_REGEX = new RegExp("^(" + BASIC_AUTH_USER_AGENTS.join("|") + ")", "");

const SESSION_PROXY_TIMEOUT = 60000;

const sandstormCoreFactory = makeSandstormCoreFactory();
const backendAddress = "unix:" + (SANDSTORM_ALTHOME || "") + Backend.socketPath;
let sandstormBackendConnection = Capnp.connect(backendAddress, sandstormCoreFactory);
let sandstormBackend = sandstormBackendConnection.restore(null, Backend);

// TODO(cleanup): This initilization belongs with the rest of our package initialization in
//   db-deprecated.js. We can't put it there now because we need to contruct sandstormCoreFactory first.
globalBackend = new SandstormBackend(globalDb, sandstormBackend);
Meteor.onConnection((connection) => {
  connection.sandstormBackend = globalBackend;
});

// We've observed a problem in production where occasionally the front-end stops talking to the
// back-end. It happens very rarely -- like once a month -- and we've been unable to reproduce it
// in testing, making it very hard to debug. The problem appears both on Sandstorm and Blackrock.
// Restarting the node process (and only the node process) always fixes the problem.
//
// Here, I've added some code that attempts to detect the problem by doing a health check
// periodically and then remaking the connection if it seems broken. We'll see if this helps!
let backendHealthy = true;
let disconnectCount = 0;
Meteor.setInterval(() => {
  if (!backendHealthy) {
    if (disconnectCount++ > 2) process.abort();
    console.error("error: Backend hasn't responded in 30 seconds! Reconnecting.");
    if (Capnp.enableVerboseDebugLogging) Capnp.enableVerboseDebugLogging(true);
    sandstormBackendConnection.close();
    sandstormBackendConnection = Capnp.connect(backendAddress, sandstormCoreFactory);
    sandstormBackend = sandstormBackendConnection.restore(null, Backend);
    globalBackend._backendCap = sandstormBackend;
  }

  const debugLog = !backendHealthy;
  backendHealthy = false;
  const promise = sandstormBackend.ping().then(() => {
    backendHealthy = true;
    if (Capnp.enableVerboseDebugLogging) Capnp.enableVerboseDebugLogging(false);
  }, (err) => {
    console.error("error: Backend ping threw error!", err.stack);
    // The connection will be remade on the next interval. Note that we do NOT normally observe
    // exceptions being thrown for this problem; we see the connection simply stop responding.
    // So we don't expect this branch to execute in any case.
  });

  if (debugLog) {
    console.log("capnp.js: outer promise:", promise);
  }
}, 30000);

// =======================================================================================
// Meteor context <-> Async Node.js context adapters
// TODO(cleanup):  Move to a different file.

const inMeteorInternal = Meteor.bindEnvironment((callback) => {
  callback();
});

inMeteor = (callback) => {
  // Calls the callback in a Meteor context.  Returns a Promise for its result.
  return new Promise((resolve, reject) => {
    inMeteorInternal(() => {
      try {
        resolve(callback());
      } catch (err) {
        reject(err);
      }
    });
  });
};

promiseToFuture = (promise) => {
  const result = new Future();
  promise.then(result.return.bind(result), result.throw.bind(result));
  return result;
};

waitPromise = (promise) => {
  return promiseToFuture(promise).wait();
};

// =======================================================================================
// API for creating / starting grains from Meteor methods.

const proxiesByHostId = {};

Meteor.methods({
  newGrain(packageId, command, title, identityId) {
    // Create and start a new grain.

    check(packageId, String);
    check(command, Object);  // Manifest.Command from package.capnp.
    check(title, String);
    check(identityId, String);

    if (!this.userId) {
      throw new Meteor.Error(403, "Unauthorized", "Must be logged in to create grains.");
    }

    if (!globalDb.userHasIdentity(this.userId, identityId)) {
      throw new Meteor.Error(403, "Current user does not own the identity: " + identityId);
    }

    if (!isSignedUpOrDemo()) {
      throw new Meteor.Error(403, "Unauthorized",
                             "Only invited users or demo users can create grains.");
    }

    if (isUserOverQuota(Meteor.user())) {
      throw new Meteor.Error(402,
          "You are out of storage space. Please delete some things and try again.");
    }

    let pkg = Packages.findOne(packageId);
    let isDev = false;
    if (!pkg) {
      // Maybe they wanted a dev package.  Check there too.
      pkg = DevPackages.findOne(packageId);
      isDev = true;
    }

    if (!pkg) {
      throw new Meteor.Error(404, "Not Found", "No such package is installed.");
    }

    const appId = pkg.appId;
    const manifest = pkg.manifest;
    const grainId = Random.id(22);  // 128 bits of entropy
    Grains.insert({
      _id: grainId,
      packageId: packageId,
      appId: appId,
      appVersion: manifest.appVersion,
      userId: this.userId,
      identityId: identityId,
      title: title,
      private: true,
    });

    globalBackend.startGrainInternal(packageId, grainId, this.userId, command, true, isDev);
    globalBackend.updateLastActive(grainId, this.userId, identityId);
    return grainId;
  },

  openSession(grainId, identityId, cachedSalt) {
    // Open a new UI session on an existing grain.  Starts the grain if it is not already
    // running.

    check(grainId, String);
    check(identityId, Match.OneOf(undefined, null, String));
    check(cachedSalt, Match.OneOf(undefined, null, String));

    if (this.userId && identityId && !globalDb.userHasIdentity(this.userId, identityId)) {
      throw new Meteor.Error(403, "Current user does not own the identity: " + identityId);
    }

    if (!Grains.findOne({ _id: grainId })) {
      throw new Meteor.Error(404, "Grain not found", "Grain ID: " + grainId);
    }

    const db = this.connection.sandstormDb;
    check(cachedSalt, Match.OneOf(undefined, null, String));
    if (!SandstormPermissions.mayOpenGrain(db,
                                           { grain: { _id: grainId, identityId: identityId } })) {
      throw new Meteor.Error(403, "Unauthorized", "User is not authorized to open this grain.");
    }

    const opened = globalBackend.openSessionInternal(grainId, this.userId, identityId,
                                                     null, null, cachedSalt);
    const result = opened.methodResult;
    const proxy = new Proxy(grainId, this.userId, result.sessionId,
                            result.hostId, identityId, false, opened.supervisor);
    proxiesByHostId[result.hostId] = proxy;
    return result;
  },

  openSessionFromApiToken(params, identityId, cachedSalt) {
    // Given an API token, either opens a new WebSession to the underlying grain or returns a
    // path to which the client should redirect in order to open such a session.

    check(params, {
      token: String,
      incognito: Boolean,
    });
    check(identityId, Match.OneOf(undefined, null, String));
    check(cachedSalt, Match.OneOf(undefined, null, String));

    if (this.userId && identityId && !globalDb.userHasIdentity(this.userId, identityId)) {
      throw new Meteor.Error(403, "Current user does not own the identity: " + identityId);
    }

    const token = params.token;
    const incognito = params.incognito;
    const hashedToken = Crypto.createHash("sha256").update(token).digest("base64");
    const apiToken = ApiTokens.findOne(hashedToken);
    validateWebkey(apiToken);
    const grain = Grains.findOne({ _id: apiToken.grainId });
    if (!grain) {
      throw new Meteor.Error(404, "Grain not found", "Grain ID: " + apiToken.grainId);
    }

    if (apiToken.accountId) {
      referralProgramLogSharingTokenUse(globalDb, apiToken.accountId);
    }

    let title;
    if (grain.userId === apiToken.accountId) {
      title = grain.title;
    } else {
      const sharerToken = apiToken.identityId &&
          ApiTokens.findOne({
            grainId: apiToken.grainId,
            "owner.user.identityId": apiToken.identityId,
          }, {
            sort: {
              "owner.user.lastUsed": -1,
            },
          });
      if (sharerToken) {
        title = sharerToken.owner.user.title;
      } else {
        title = "shared grain";
      }
    }

    if (this.userId && !incognito) {
      if (identityId != apiToken.identityId && identityId != grain.identityId &&
          !ApiTokens.findOne({ "owner.user.identityId": identityId, parentToken: hashedToken })) {
        const owner = { user: { identityId: identityId, title: title } };

        // Create a new API token for the identity redeeming this token.
        const result = SandstormPermissions.createNewApiToken(
          globalDb, { rawParentToken: token }, apiToken.grainId, apiToken.petname, { allAccess: null }, owner);
        globalDb.addContact(apiToken.accountId, identityId);

        // If the parent API token is forSharing and it has an accountId, then the logged-in user (call
        // them Bob) is about to access a grain owned by someone (call them Alice) and save a reference
        // to it as a new ApiToken. (For share-by-link, this occurs when viewing the grain. For
        // share-by-identity, this happens immediately.)
        if (result.parentApiToken) {
          const parentApiToken = result.parentApiToken;
          if (parentApiToken.forSharing && parentApiToken.accountId) {
            storeReferralProgramInfoApiTokenCreated(
              globalDb, this.userId, owner.user.identityId, parentApiToken.accountId);
          }
        }
      }

      return { redirectToGrain: apiToken.grainId };
    } else {
      if (!SandstormPermissions.mayOpenGrain(globalDb, { token: apiToken })) {
        throw new Meteor.Error(403, "Unauthorized",
                               "User is not authorized to open this grain.");
      }

      const opened = globalBackend.openSessionInternal(apiToken.grainId, null, null,
                                                       title, apiToken, cachedSalt);

      const result = opened.methodResult;
      const proxy = new Proxy(apiToken.grainId, grain.userId, result.sessionId,
                              result.hostId, identityId, false);
      proxy.apiToken = apiToken;
      proxiesByHostId[result.hostId] = proxy;
      return result;
    }
  },

  keepSessionAlive(sessionId) {
    // TODO(security):  Prevent draining someone else's quota by holding open several grains shared
    //   by them.
    check(sessionId, String);

    const session = Sessions.findAndModify({
      query: { _id: sessionId },
      update: { $set: { timestamp: new Date().getTime() } },
      fields: { grainId: 1, identityId: 1, hostId: 1 },
    });

    if (session) {
      // Session still present in database, so send keep-alive to backend.
      try {
        const grainId = session.grainId;
        const hostId = session.hostId;
        let supervisor = proxiesByHostId[hostId] && proxiesByHostId[hostId].supervisor;
        if (!supervisor) {
          supervisor = globalBackend.continueGrain(grainId).supervisor;
        }

        waitPromise(supervisor.keepAlive());
        globalBackend.updateLastActive(grainId, this.userId, session.identityId);
      } catch (err) {
        // Ignore disconnects, which imply that the grain shut down already. It'll start back up on
        // the next request, so whatever.
        if (err.kjType !== "disconnected") {
          throw err;
        }
      }

      return true;
    } else {
      return false;
    }
  },

  shutdownGrain(grainId) {
    check(grainId, String);
    const grain = Grains.findOne(grainId);
    if (!grain || !this.userId || grain.userId !== this.userId) {
      throw new Meteor.Error(403, "Unauthorized", "User is not the owner of this grain");
    }

    waitPromise(globalBackend.shutdownGrain(grainId, grain.userId, true));
  },
});

const validateWebkey = (apiToken, refreshedExpiration) => {
  // Validates that `apiToken` is a valid UiView webkey, throwing an exception if it is not. If
  // `refreshedExpiration` is set and if the token has an `expiresIfUnused` field, then the
  // `expiresIfUnused` field is reset to `refreshedExpiration`.

  if (!apiToken) {
    throw new Meteor.Error(403, "Invalid authorization token");
  }

  if (apiToken.revoked) {
    throw new Meteor.Error(403, "Authorization token has been revoked");
  }

  if (apiToken.owner && !("webkey" in apiToken.owner)) {
    throw new Meteor.Error(403, "Unauthorized to open non-webkey token.");
  }

  if (apiToken.expires && apiToken.expires.getTime() <= Date.now()) {
    throw new Meteor.Error(403, "Authorization token expired");
  }

  if (apiToken.expiresIfUnused) {
    if (apiToken.expiresIfUnused.getTime() <= Date.now()) {
      throw new Meteor.Error(403, "Authorization token expired");
    } else if (refreshedExpiration) {
      ApiTokens.update(apiToken._id, { $set: { expiresIfUnused: refreshedExpiration } });
    } else {
      // It's getting used now, so clear the expiresIfUnused field.
      ApiTokens.update(apiToken._id, { $set: { expiresIfUnused: null } });
    }
  }

  if (apiToken.objectId || apiToken.frontendRef) {
    throw new Meteor.Error(403, "ApiToken refers to a non-webview Capability.");
  }
};

// Used by shared/grain.js (which sounds like a broken dependency, since this code is only available
// on the server)
getGrainSize = (supervisor, oldSize) => {
  let promise;
  if (oldSize === undefined) {
    promise = supervisor.getGrainSize();
  } else {
    promise = supervisor.getGrainSizeWhenDifferent(oldSize);
  }

  const promise2 = promise.then((result) => { return parseInt(result.size); });
  promise2.cancel = () => { promise.cancel(); };

  return promise2;
};

Meteor.startup(() => {
  const shutdownApp = (appId) => {
    Grains.find({ appId: appId }).forEach((grain) => {
      waitPromise(globalBackend.shutdownGrain(grain._id, grain.userId));
    });
  };

  DevPackages.find().observe({
    removed(devPackage) { shutdownApp(devPackage.appId); },

    changed(oldDevPackage, newDevPackage) {
      shutdownApp(oldDevPackage.appId);
      if (oldDevPackage.appId !== newDevPackage.appId) {
        shutdownApp(newDevPackage.appId);
      }
    },

    added(devPackage) { shutdownApp(devPackage.appId); },
  });

  Sessions.find().observe({
    removed(session) {
      const proxy = proxiesByHostId[session.hostId];
      delete proxiesByHostId[session.hostId];
      if (proxy) {
        proxy.close();
      }
    },
  });
});

// Kill off sessions idle for >~3 minutes.
const TIMEOUT_MS = 180000;
const gcSessions = () => {
  const now = new Date().getTime();
  Sessions.remove({ timestamp: { $lt: (now - TIMEOUT_MS) } });
};

SandstormDb.periodicCleanup(TIMEOUT_MS, gcSessions);

const getProxyForHostId = (hostId, isAlreadyOpened) => {
  // Get the Proxy corresponding to the given grain session host, possibly (re)creating it if it
  // doesn't already exist. The first request on the session host will always create a new proxy.
  // Later requests may create a proxy if they go to a different front-end replica or if the
  // front-end was restarted.
  check(hostId, String);

  return Promise.resolve(undefined).then(() => {
    const proxy = proxiesByHostId[hostId];
    if (proxy) {
      return proxy;
    } else {
      // Set table entry to null for now so that we can detect if it is concurrently deleted.
      proxiesByHostId[hostId] = null;

      return inMeteor(() => {
        const session = Sessions.findOne({ hostId: hostId });
        if (!session) {
          if (isAlreadyOpened) {
            return new Promise((resolve, reject) => {
              let observer;
              const task = Meteor.setTimeout(() => {
                observer.stop();
                reject(new Meteor.Error(504, "Requested session that no longer exists, and " +
                    "timed out waiting for client to restore it. This can happen if you have " +
                    "opened an app's content in a new window and then closed it in the " +
                    "UI. If you see this error *inside* the Sandstorm UI, please report a " +
                    "bug and describe the circumstances of the error."));
              }, SESSION_PROXY_TIMEOUT);
              observer = Sessions.find({ hostId: hostId }).observe({
                added() {
                  observer.stop();
                  Meteor.clearTimeout(task);
                  resolve(getProxyForHostId(hostId, false));
                },
              });
            });
          } else {
            // Does not appear to be a valid session host.
            return undefined;
          }
        }

        let apiToken;
        if (session.hashedToken) {
          apiToken = ApiTokens.findOne({ _id: session.hashedToken });
          // We don't have to fully validate the API token here because if it changed the session
          // would have been deleted.
          if (!apiToken) {
            throw new Meteor.Error(410, "ApiToken has been deleted");
          }
        }

        const grain = Grains.findOne(session.grainId);
        if (!grain) {
          // Grain was deleted, I guess.
          throw new Meteor.Error(410, "Resource has been deleted");
        }

        // Note that we don't need to call mayOpenGrain() because the existence of a session
        // implies this check was already performed.

        const proxy = new Proxy(grain._id, grain.userId, session._id, hostId, session.identityId, false);
        if (apiToken) proxy.apiToken = apiToken;

        // Only add the proxy to the table if it was not concurrently deleted (which could happen
        // e.g. if the user's access was revoked).
        if (hostId in proxiesByHostId) {
          proxiesByHostId[hostId] = proxy;
        } else {
          throw new Meteor.Error(403, "Session was concurrently closed.");
        }

        return proxy;
      });
    }
  });
};

// =======================================================================================
// API tokens

class ApiSessionProxies {
  // Class that caches proxies for requests that come in through HTTP API endpoints. Such
  // requests are not associated with any entry in the `Sessions` collection, so we need
  // some other means of detecting unused proxies and closing them. This class works by keeping
  // the proxies in two buckets. When a proxy is used, it is put in the new bucket. Periodically,
  // the old bucket is emptied and the contents of new bucket are moved to the old bucket.
  //
  // Each bucket is a two-level map, keyed by hashes of the tokens and their `ApiSession.Params`
  // structs.

  constructor(intervalMillis) {
    check(intervalMillis, Number);
    this.newBucket = {};
    this.oldBucket = {};
    this.interval = Meteor.setInterval(() => {
      for (const oldHashedToken in this.oldBucket) {
        for (const oldHashedParams in this.oldBucket[oldHashedToken]) {
          const newProxy = this.newBucket[oldHashedToken] &&
                this.newBucket[oldHashedToken][oldHashedParams];
          const oldProxy = this.oldBucket[oldHashedToken][oldHashedParams];
          if (oldProxy && !newProxy) {
            if (Object.keys(oldProxy.websockets).length > 0) {
              // A client has an open websocket. Keep the proxy around.
              this.put(oldHashedToken, oldHashedParams, oldProxy);
            } else {
              // We can close this proxy and forget about it.
              oldProxy.close();
            }
          }
        }
      }

      this.oldBucket = this.newBucket;
      this.newBucket = {};
    }, intervalMillis);
  }

  get(hashedToken, hashedParams) {
    if (this.newBucket[hashedToken] && this.newBucket[hashedToken][hashedParams]) {
      return this.newBucket[hashedToken][hashedParams];
    } else if (this.oldBucket[hashedToken] && this.oldBucket[hashedToken][hashedParams]) {
      const proxy = this.oldBucket[hashedToken][hashedParams];
      delete this.oldBucket[hashedToken][hashedParams];
      this.put(hashedToken, hashedParams, proxy);
      return proxy;
    } else {
      return null;
    }
  }

  put(hashedToken, hashedParams, proxy) {
    if (!this.newBucket[hashedToken]) {
      this.newBucket[hashedToken] = {};
    }

    this.newBucket[hashedToken][hashedParams] = proxy;
  }

  removeProxiesOfToken(hashedToken) {
    if (hashedToken in this.oldBucket) {
      for (const hashedParams in this.oldBucket[hashedToken]) {
        this.oldBucket[hashedToken][hashedParams].close();
      }

      delete this.oldBucket[hashedToken];
    }

    if (hashedToken in this.newBucket) {
      for (const hashedParams in this.newBucket[hashedToken]) {
        this.newBucket[hashedToken][hashedParams].close();
      }

      delete this.newBucket[hashedToken];
    }
  }
}

const apiSessionProxies = new ApiSessionProxies(3 * 60 * 1000);

Meteor.startup(() => {
  const clearSessionsAndProxies = (token) => {
    // Clears all sessions and API proxies associated with `token` or any token that is downstream
    // in the sharing graph.
    // TODO(soon): Only clear sessions and proxies for which the permissions have changed.
    const downstream = SandstormPermissions.downstreamTokens(globalDb, { token: token });
    downstream.push(token);
    const identityIds = [];
    const tokenIds = [];

    downstream.forEach((token) => {
      apiSessionProxies.removeProxiesOfToken(token._id);

      tokenIds.push(token._id);
      if (token.owner && token.owner.user) {
        identityIds.push(token.owner.user.identityId);
      }
    });

    Sessions.find({
      grainId: token.grainId,
      $or: [{ identityId: { $in: identityIds } },
        { hashedToken: { $in: tokenIds } },
      ],
    }, {
      fields: { hostId: 1 },
    }).forEach((session) => {
      const proxy = proxiesByHostId[session.hostId];
      if (proxy) {
        proxy.close();
      }

      delete proxiesByHostId[session.hostId];
    });

    Sessions.remove({
      grainId: token.grainId,
      $or: [
        { identityId: { $in: identityIds } },
        { hashedToken: { $in: tokenIds } },
      ],
    });
  };

  Grains.find().observe({
    changed(newGrain, oldGrain) {
      if (oldGrain.private != newGrain.private) {
        Sessions.remove({ grainId: oldGrain._id, identityId: { $ne: oldGrain.identityId } });
        ApiTokens.find({ grainId: oldGrain._id }).forEach((apiToken) => {
          apiSessionProxies.removeProxiesOfToken(apiToken._id);
        });
      }
    },
  });

  ApiTokens.find({ grainId: { $exists: true }, objectId: { $exists: false } }).observe({
    added(newApiToken) {
      // TODO(soon): Unfortunately, added() gets called for all existing role assignments when the
      //   front-end restarts, meaning clearing sessions here will cause people's views to refresh
      //   on server upgrade, which is not a nice user experience. It's also sad to force-refresh
      //   people when they gained new permissions since they might be in the middle of something,
      //   and it's not strictly necessary for security. OTOH, it's sad to be non-reactive. Maybe
      //   we should notify people that they have new permissions and let them click a thing to
      //   refresh?
      //clearSessions(roleAssignment.grainId, roleAssignment.recipient);
      //clearApiProxies(roleAssignment.grainId);
    },

    changed(newApiToken, oldApiToken) {
      if (!_.isEqual(newApiToken.roleAssignment, oldApiToken.roleAssignment) ||
          !_.isEqual(newApiToken.revoked, oldApiToken.revoked)) {
        clearSessionsAndProxies(newApiToken);
      }
    },

    removed(oldApiToken) {
      clearSessionsAndProxies(oldApiToken);
    },
  });
});

function getApiSessionParams(request) {
  const params = {};
  if ("x-sandstorm-passthrough" in request.headers) {
    const optIns = request.headers["x-sandstorm-passthrough"]
          .split(",")
          .map((s) => { return s.trim(); });
    // The only currently supported passthrough value is 'address', but others could be useful in
    // the future.

    if (optIns.indexOf("address") !== -1) {
      // Sadly, we can't use request.socket.remoteFamily because it's not available in the
      // (rather-old) version of node that comes in the Meteor bundle we're using. Hence this
      // hackery.
      let addressToPass = request.socket.remoteAddress;
      if (isRfc1918OrLocal(addressToPass) && "x-real-ip" in request.headers) {
        // Allow overriding the socket's remote address with X-Real-IP header if the request comes
        // from either localhost or an RFC1918 address. These are not useful for geolocation anyway.
        addressToPass = request.headers["x-real-ip"];
      }

      if (Net.isIPv4(addressToPass)) {
        // Map IPv4 addresses in IPv6.
        // This conveniently comes out to a 48-bit number, which is precisely representable in a
        // double (which has 53 mantissa bits). Thus we can avoid using Bignum/strings, which we
        // might otherwise need to precisely represent 64-bit fields.
        const v4Int = 0xFFFF00000000 + addressToPass.split(".")
              .map((x) => { return parseInt(x, 10); })
              .reduce((a, b) => { return (256 * a) + b; });
        params.remoteAddress = {
          lower64: v4Int,
          upper64: 0,
        };
      } else if (Net.isIPv6(addressToPass)) {
        // TODO(test): Unit test this
        // Parse a valid v6 address.
        // Split into groups, then insert an appropriate number of 0's if :: was used.
        const groups = addressToPass.split(":");

        // Strip extra empty group in the case of a leading or trailing '::'.
        if (groups[0] === "") {
          groups.shift();
        }

        if (groups[groups.length - 1] === "") {
          groups.pop();
        }

        const lastGroup = groups[groups.length - 1];
        // Handle IPv4-mapped IPv6 addresses.  These end in a dotted-quad IPv4 address, which we
        // should expand into two groups of 4-character hex strings, like the rest of the address.
        if (Net.isIPv4(lastGroup)) {
          groups.pop();
          const quad = lastGroup.split(".").map((x) => { return parseInt(x, 10); });
          groups.push(((quad[0] * 256) + quad[1]).toString(16));
          groups.push(((quad[2] * 256) + quad[3]).toString(16));
        }

        const groupsToAdd = 8 - groups.length;
        const emptyGroupIndex = groups.indexOf("");
        let cleanGroups;
        if (emptyGroupIndex !== -1) {
          const head = groups.slice(0, emptyGroupIndex);
          // groupsToAdd + 1 because we sliced out the empty element
          const mid = Array(groupsToAdd + 1);
          for (let i = 0; i < groupsToAdd + 1; i++) {
            mid[i] = "0";
          }

          const tail = groups.slice(emptyGroupIndex + 1, groups.length);
          cleanGroups = [].concat(head, mid, tail);
        } else {
          cleanGroups = groups;
        }

        const ints = cleanGroups.map((x) => { return parseInt(x, 16); });
        // We use strings because we'd lose data from loss of precision casting the 64-bit uints
        // into 53-bit-mantissa doubles.
        params.remoteAddress = {
          upper64: quadToIntString(ints.slice(0, 4)),
          lower64: quadToIntString(ints.slice(4, 8)),
        };
      }
    }
  }

  return Capnp.serialize(ApiSession.Params, params);
}

// Used by server/drivers/external-ui/view.js
getProxyForApiToken = (token, request) => {
  check(token, String);
  const hashedToken = Crypto.createHash("sha256").update(token).digest("base64");
  const serializedParams = getApiSessionParams(request);
  const hashedParams = Crypto.createHash("sha256").update(serializedParams).digest("base64");
  return Promise.resolve(undefined).then(() => {
    const proxy = apiSessionProxies.get(hashedToken, hashedParams);
    if (proxy) {
      if (proxy.expires && proxy.expires.getTime() <= Date.now()) {
        throw new Meteor.Error(403, "Authorization token expired");
      }

      return proxy;
    } else {
      return inMeteor(() => {
        const tokenInfo = ApiTokens.findOne(hashedToken);
        validateWebkey(tokenInfo);

        const grain = Grains.findOne(tokenInfo.grainId);
        if (!grain) {
          // Grain was deleted, I guess.
          throw new Meteor.Error(410, "Resource has been deleted");
        }

        let proxy;
        if (tokenInfo.userInfo) {
          throw new Error("API tokens created with arbitrary userInfo no longer supported");
        } else {
          let identityId = null;
          if (tokenInfo.identityId && !tokenInfo.forSharing) {
            identityId = tokenInfo.identityId;
          }

          proxy = new Proxy(tokenInfo.grainId, grain.userId, null, null, identityId, true);
          proxy.apiToken = tokenInfo;
          proxy.apiSessionParams = serializedParams;
        }

        if (!SandstormPermissions.mayOpenGrain(globalDb, { token: tokenInfo })) {
          // Note that only public grains may be opened without a user ID.
          throw new Meteor.Error(403, "Unauthorized.");
        }

        if (tokenInfo.expires) {
          proxy.expires = tokenInfo.expires;
        }

        apiSessionProxies.put(hashedToken, hashedParams, proxy);

        return proxy;
      });
    }
  });
};

const apiUseBasicAuth = (req, hostId) => {
  // If the request was to a token-specific host *and* the request has no Origin header (meaning
  // it is not an XHR from a web site), then we permit the use of HTTP basic auth. The reason we
  // prohibit XHRs is because we want to discourage people from using basic auth in a browser,
  // because the browser will cache the credentials, which exposes the hostname to XSRF attack
  // (which is mostly, but not completely, mitigated by the unguessable hostname). The reason we
  // want to allow basic auth at all is because a lot of existing client apps support only basic
  // auth. New clients and web-based clients should use `Authorization: bearer <token>` instead.
  if (globalDb.isTokenSpecificHostId(hostId) && !req.headers.origin) {
    return true;
  }

  // Historically, all API tokens were served from the same host rather than have token-specific
  // hosts. In this model, basic auth in browsers was far more dangerous since the hostname was
  // not a secret -- in fact, even benign attempts to use two APIs on the same server from the same
  // browser could interfere if using basic auth. Hence, basic auth was prohibited except when
  // coming from certain whitelisted clients known not to be browsers, e.g. Mirall, the ownCloud
  // client app.
  //
  // Since many clients in the wild have already been configured to use the shared API host, we
  // must continue to support them, so this logic remains.
  const agent = req.headers["user-agent"];
  return agent.match(BASIC_AUTH_USER_AGENTS_REGEX);
};

const apiTokenForRequest = (req, hostId) => {
  // Extract the API token from the request.

  const auth = req.headers.authorization;
  let token;
  if (auth && auth.slice(0, 7).toLowerCase() === "bearer ") {
    token = auth.slice(7).trim();
  } else if (auth && auth.slice(0, 6).toLowerCase() === "basic " &&
             apiUseBasicAuth(req, hostId)) {
    token = (new Buffer(auth.slice(6).trim(), "base64")).toString().split(":")[1];
  } else {
    token = undefined;
  }

  if (token && hostId !== "api") {
    // Verify that the token matches the specific host.
    if (hostId !== globalDb.apiHostIdForToken(token)) {
      token = undefined;
    }
  }

  return token;
};

// =======================================================================================
// Routing to proxies.
//

// pre-meteor.js calls this
tryProxyUpgrade = (hostId, req, socket, head) => {
  // Attempt to handle a WebSocket upgrade by dispatching it to a grain. Returns a promise that
  // resolves true if an appropriate grain is found, false if there was no match (but the caller
  // should consider other host types, like static web publishing), or throws an error if the
  // request is definitely invalid.

  if (globalDb.isApiHostId(hostId)) {
    const token = apiTokenForRequest(req, hostId);
    if (token) {
      return getProxyForApiToken(token).then((proxy) => {
        // Meteor sets the timeout to five seconds. Change that back to two
        // minutes, which is the default value.
        socket.setTimeout(120000);

        proxy.upgradeHandler(req, socket, head);
        return true;
      });
    } else {
      return Promise.resolve(false);
    }
  } else {
    const isAlreadyOpened = req.headers.cookie && req.headers.cookie.indexOf("sandstorm-sid=") !== -1;
    return getProxyForHostId(hostId, isAlreadyOpened).then((proxy) => {
      if (proxy) {
        // Cross-origin requests are not allowed on UI session hosts.
        const origin = req.headers.origin;
        if (origin !== (PROTOCOL + "//" + req.headers.host)) {
          throw new Meteor.Error(403, "Detected illegal cross-origin WebSocket from: " + origin);
        }

        // Meteor sets the timeout to five seconds. Change that back to two
        // minutes, which is the default value.
        socket.setTimeout(120000);

        proxy.upgradeHandler(req, socket, head);
        return true;
      } else {
        return false;
      }
    });
  }
};

// pre-meteor.js calls this
tryProxyRequest = (hostId, req, res) => {
  // Attempt to handle an HTTP request by dispatching it to a grain. Returns a promise that
  // resolves true if an appropriate grain is found, false if there was no match (but the caller
  // should consider other host types, like static web publishing), or throws an error if the
  // request is definitely invalid.

  const hostIdHash = globalDb.isApiHostId(hostId);
  if (hostIdHash) {
    // This is a request for the API host.

    res.setHeader("Access-Control-Allow-Origin", "*");

    if (req.method === "OPTIONS") {
      // Reply to CORS preflight request.

      // All we want to do is permit APIs to be accessed from arbitrary origins. Since clients
      // must send a valid Authorization header, and since cookies are not used for
      // authorization, this is perfectly safe. In a sane world, we would only need to send back
      // 'Access-Control-Allow-Origin: *' and be done with it.
      //
      // However, CORS demands that we explicitly whitelist individual methods and headers for
      // use cross-origin, as if this is somehow useful for implementing any practical security
      // policy (it isn't). To make matters worse, we are REQUIRED to enumerate each one
      // individually. We cannot just write '*' for these lists. WTF, CORS?
      //
      // Luckily, the request tells us exactly what method and headers are being requested, so we
      // only need to copy those over, rather than create an exhaustive list. But this is still
      // overly complicated.

      const accessControlHeaders = {
        "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, PATCH, DELETE",
        "Access-Control-Max-Age": "3600",
      };

      // Copy all requested headers to the allowed headers list.
      const requestedHeaders = req.headers["access-control-request-headers"];
      if (requestedHeaders) {
        accessControlHeaders["Access-Control-Allow-Headers"] = requestedHeaders;
      }

      // Add the requested method to the allowed methods list, if it's not there already.
      const requestedMethod = req.headers["access-control-request-method"];
      if (requestedMethod &&
          !(_.contains(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"], requestedMethod))) {
        accessControlHeaders["Access-Control-Allow-Methods"] += ", " + requestedMethod;
      }

      for (header in accessControlHeaders) {
        res.setHeader(header, accessControlHeaders[header]);
      }
    }

    const errorHandler = (err) => {
      if (err instanceof Meteor.Error) {
        console.log("error: " + err);
        res.writeHead(err.error, err.reason, { "Content-Type": "text/plain" });
      } else {
        res.writeHead(500, "Internal Server Error", { "Content-Type": "text/plain" });
      }

      res.end(err.stack);
    };

    const token = apiTokenForRequest(req, hostId);
    if (token && req.headers["x-sandstorm-token-keepalive"]) {
      inMeteor(() => {
        const keepaliveDuration = parseInt(req.headers["x-sandstorm-token-keepalive"]);
        check(keepaliveDuration, Match.Integer);
        const hashedToken = Crypto.createHash("sha256").update(token).digest("base64");
        validateWebkey(ApiTokens.findOne(hashedToken), new Date(Date.now() + keepaliveDuration));
      }).then(() => {
        res.writeHead(200, {});
        res.end();
      }, errorHandler);
    } else if (token) {
      getProxyForApiToken(token, req).then((proxy) => {
        proxy.requestHandler(req, res);
      }, errorHandler);
    } else {
      // No token. Look up static API host info.
      inMeteor(() => {
        const apiHost = globalDb.collections.apiHosts.findOne(hostIdHash);

        if (req.method === "OPTIONS") {
          // OPTIONS request with no authorization token.

          const dav = ((apiHost || {}).options || {}).dav || [];
          if (dav.length > 0) {
            res.setHeader("DAV", dav.join(", "));
            res.setHeader("Access-Control-Expose-Headers", "DAV");
          }

          res.writeHead(200, {});
          res.end();
        } else {
          const resources = (apiHost || {}).resources || {};
          const path = SandstormDb.escapeMongoKey(req.url.split("?")[0]);
          if (path in resources) {
            // Serve a static resource.
            const resource = resources[path];
            console.log(path, resources, resource);
            if (resource.language) res.setHeader("Content-Language", resource.language);
            if (resource.encoding) res.setHeader("Content-Encoding", resource.encoding);
            res.writeHead(200, {
              "Content-Type": resource.type,
            });
            res.end(resource.body);
          } else {
            if (apiUseBasicAuth(req, hostId)) {
              res.writeHead(401, {
                "Content-Type": "text/plain",
                "WWW-Authenticate": "Basic realm='Sandstorm API'",
              });
            } else {
              // TODO(someday): Display some sort of nifty API browser.
              res.writeHead(403, { "Content-Type": "text/plain" });
            }

            res.end("Missing or invalid authorization header.\n\n" +
                "This address serves APIs, which allow external apps (such as a phone app) to\n" +
                "access data on your Sandstorm server. This address is not meant to be opened\n" +
                "in a regular browser.");
          }
        }
      }).then(() => {}, errorHandler);
    }

    return Promise.resolve(true);
  } else {
    const isAlreadyOpened = req.headers.cookie && req.headers.cookie.indexOf("sandstorm-sid=") !== -1;
    return getProxyForHostId(hostId, isAlreadyOpened).then((proxy) => {
      if (proxy) {
        proxy.requestHandler(req, res);
        return true;
      } else {
        return false;
      }
    });
  }
};

// =======================================================================================
// Proxy class
//
// Connects to a grain and exports it on a wildcard host.
//

class Proxy {
  constructor(grainId, ownerId, sessionId, hostId, identityId, isApi, supervisor) {
    this.grainId = grainId;
    this.ownerId = ownerId;
    this.identityId = identityId;
    this.supervisor = supervisor;  // note: optional parameter; we can reconnect
    this.sessionId = sessionId;
    this.isApi = isApi;
    this.hasLoaded = false;
    this.websockets = {};
    this.websocketCounter = 0; // Used for generating unique socket IDs.
    if (sessionId) {
      if (!hostId) throw new Error("sessionId must come with hostId");
      if (isApi) throw new Error("API proxy shouldn't have sessionId");
      this.hostId = hostId;
    } else {
      if (!isApi) throw new Error("non-API proxy requires sessionId");
      if (hostId) throw new Error("API proxy sholudn't have hostId");
    }

    if (this.identityId) {
      const identity = globalDb.getIdentity(this.identityId);
      if (!identity) {
        throw new Error("identity not found: " + this.identityId);
      }

      this.userInfo = {
        displayName: { defaultText: identity.profile.name },
        preferredHandle: identity.profile.handle,
        identityId: new Buffer(identity._id, "hex"),
      };
      if (identity.profile.pictureUrl) this.userInfo.pictureUrl = identity.profile.pictureUrl;
      if (identity.profile.pronoun) this.userInfo.pronouns = identity.profile.pronoun;
    } else {
      this.userInfo = {
        displayName: { defaultText: "Anonymous User" },
        preferredHandle: "anonymous",
      };
    }

    const _this = this;

    this.requestHandler = (request, response) => {
      if (this.sessionId) {
        // Implement /_sandstorm-init for setting the session cookie.
        const url = Url.parse(request.url, true);
        if (url.pathname === "/_sandstorm-init" && url.query.sessionid === _this.sessionId) {
          _this.doSessionInit(request, response, url.query.path);
          return;
        }
      }

      Promise.resolve(undefined).then(() => {
        const contentLength = request.headers["content-length"];
        if ((request.method === "POST" || request.method === "PUT") &&
            (contentLength === undefined || contentLength > 1024 * 1024)) {
          // The input is either very long, or we don't know how long it is, so use streaming mode.
          return _this.handleRequestStreaming(request, response, contentLength, 0);
        } else {
          return readAll(request).then((data) => {
            return _this.handleRequest(request, data, response, 0);
          });
        }
      }).catch((err) => {
        _this.setHasLoaded();

        let body = err.stack;
        if (err.cppFile) {
          body += "\nC++ location:" + err.cppFile + ":" + (err.line || "??");
        }

        if (err.kjType) {
          body += "\ntype: " + err.kjType;
        }

        if (response.headersSent) {
          // Unfortunately, it's too late to tell the client what happened.
          console.error("HTTP request failed after response already sent:", body);
          response.end();
        } else {
          if (err instanceof Meteor.Error) {
            response.writeHead(err.error, err.reason, { "Content-Type": "text/plain" });
          } else {
            response.writeHead(500, "Internal Server Error", { "Content-Type": "text/plain" });
          }

          response.end(body);
        }
      });
    };

    this.upgradeHandler = (request, socket, head) => {
      _this.handleWebSocket(request, socket, head, 0).catch((err) => {
        console.error("WebSocket setup failed:", err.stack);
        // TODO(cleanup):  Manually send back a 500 response?
        socket.destroy();
      });
    };
  }

  close() {
    for (const socketIdx in this.websockets) {
      this.websockets[socketIdx].destroy();
    };

    this.websockets = {};

    if (this.session) {
      this.session.close();
      delete this.session;
    }

    if (this.uiView) {
      this.uiView.close();
      delete this.uiView;
    }

    if (this.supervisor) {
      this.supervisor.close();
      delete this.supervisor;
    }
  }

  getConnection() {
    if (!this.supervisor) {
      this.supervisor = globalBackend.cap().getGrain(this.ownerId, this.grainId).supervisor;
      this.uiView = null;
    }

    if (!this.uiView) {
      this.uiView = this.supervisor.getMainView().view;
    }
  }

  _callNewWebSession(request, userInfo) {
    const params = Capnp.serialize(WebSession.Params, {
      basePath: PROTOCOL + "//" + request.headers.host,
      userAgent: "user-agent" in request.headers
          ? request.headers["user-agent"]
          : "UnknownAgent/0.0",
      acceptableLanguages: "accept-language" in request.headers
          ? request.headers["accept-language"].split(",").map((s) => { return s.trim(); })
          : ["en-US", "en"],
    });
    return this.uiView.newSession(userInfo,
                                  makeHackSessionContext(this.grainId, this.sessionId, this.identityId),
                                  WebSession.typeId, params).session;
  }

  _callNewApiSession(request, userInfo) {
    const serializedParams = this.apiSessionParams;
    if (!serializedParams) {
      throw new Meteor.Error(500, "Should have already computed apiSessionParams.");
    }

    // TODO(someday): We are currently falling back to WebSession if we get any kind of error upon
    // calling newSession with an ApiSession._id.
    // Eventually we'll remove this logic once we're sure apps have updated.
    return this.uiView.newSession(userInfo,
                                  makeHackSessionContext(this.grainId, this.sessionId, this.identityId),
                                  ApiSession.typeId, serializedParams)
                      .then((session) => {
                        return session.session;
                      }, (err) => {
                        return this._callNewWebSession(request, userInfo);
                      }
    );
  };

  _callNewSession(request, viewInfo) {
    const userInfo = _.clone(this.userInfo);
    const _this = this;
    const promise = inMeteor(() => {
      let vertex;
      if (_this.apiToken) {
        vertex = { token: _this.apiToken };
      } else {
        // (_this.identityId might be null; this is fine)
        vertex = { grain: { _id: _this.grainId, identityId: _this.identityId } };
      }

      const permissions = SandstormPermissions.grainPermissions(globalDb, vertex, viewInfo);
      if (!permissions) {
        throw new Meteor.Error(403, "Unauthorized", "User is not authorized to open this grain.");
      }

      Sessions.update({
        _id: _this.sessionId,
      }, {
        $set: {
          viewInfo: viewInfo,
          permissions: permissions,
        },
      });

      return permissions;
    });

    return promise.then((permissions) => {
      userInfo.permissions = permissions;

      const numBytes = Math.ceil(permissions.length / 8);
      const buf = new Buffer(numBytes);
      for (let ii = 0; ii < numBytes; ++ii) {
        buf[ii] = 0;
      }

      for (let ii = 0; ii < permissions.length; ++ii) {
        const byteNum = Math.floor(ii / 8);
        const bitNum = ii % 8;
        if (permissions[ii]) {
          buf[byteNum] = (buf[byteNum] | (1 << bitNum));
        }
      }

      userInfo.deprecatedPermissionsBlob = buf;

      if (_this.isApi) {
        return _this._callNewApiSession(request, userInfo);
      } else {
        return _this._callNewWebSession(request, userInfo);
      }
    });
  };

  getSession(request) {
    if (!this.session) {
      this.getConnection();  // make sure we're connected
      const _this = this;
      const promise = this.uiView.getViewInfo().then((viewInfo) => {
        return inMeteor(() => {
          Grains.update(_this.grainId, { $set: { cachedViewInfo: viewInfo } });
        }).then(() => {
          return _this._callNewSession(request, viewInfo);
        });
      }, (error) => {
        if (error.kjType === "failed" || error.kjType === "unimplemented") {
          // Method not implemented.
          // TODO(apibump): Don't treat 'failed' as 'unimplemented'. Unfortunately, old apps built
          //   with old versions of Cap'n Proto don't throw 'unimplemented' exceptions, so we have
          //   to accept 'failed' here at least until the next API bump.
          return _this._callNewSession(request, {});
        } else {
          return Promise.reject(error);
        }
      });
      this.session = new Capnp.Capability(promise, WebSession);
    }

    return this.session;
  }

  keepAlive() {
    this.getConnection();
    return this.supervisor.keepAlive();
  }

  resetConnection() {
    if (this.session) {
      this.session.close();
      delete this.session;
    }

    if (this.uiView) {
      this.uiView.close();
      delete this.uiView;
    }

    if (this.supervisor) {
      this.supervisor.close();
      delete this.supervisor;
    }
  }

  maybeRetryAfterError(error, retryCount) {
    // If the error may be caused by the grain dying or a network failure, try to restart it,
    // returning a promise that resolves once restarted. Otherwise, just rethrow the error.
    // `retryCount` should be incremented for every successful retry as part of the same request;
    // we only want to retry once.
    const _this = this;
    if (SandstormBackend.shouldRestartGrain(error, retryCount)) {
      this.resetConnection();
      return inMeteor(() => {
        _this.supervisor = globalBackend.continueGrain(_this.grainId).supervisor;
      });
    } else {
      throw error;
    }
  }

  doSessionInit(request, response, requestPath) {
    // jscs:disable disallowQuotedKeysInObjects
    const path = requestPath || "/";

    // Check that the path is relative (ie. starts with a /).
    // Also ensure that it doesn't start with 2 /, because that is interpreted as non-relative
    if (path.lastIndexOf("/", 0) !== 0 || path.lastIndexOf("//", 0) === 0) {
      response.writeHead(400, "Invalid path supplied", { "Content-Type": "text/plain" });
      response.end("Invalid path supplied.");
      return;
    }

    // Set the session ID.
    response.setHeader("Set-Cookie", ["sandstorm-sid=", this.sessionId, "; Max-Age=31536000; HttpOnly"].join(""));

    response.setHeader("Cache-Control", "no-cache, private");

    // Redirect to the app's root URL.
    // Note:  All browsers support relative locations and the next update to HTTP/1.1 will officially
    //   make them valid.  http://tools.ietf.org/html/draft-ietf-httpbis-p2-semantics-26#page-67
    response.writeHead(303, "See Other", { "Location": encodeURI(path) });
    response.end();
  }

  makeContext(request, response) {
    // Parses the cookies from the request, checks that the session ID is present and valid, then
    // returns the request context which contains the other cookies.  Throws an exception if the
    // session ID is missing or invalid.

    const context = {};

    if (this.hostId) {
      const parseResult = parseCookies(request);
      if (!parseResult.sessionId || parseResult.sessionId !== this.sessionId) {
        throw new Meteor.Error(403, "Unauthorized");
      }

      if (parseResult.cookies.length > 0) {
        context.cookies = parseResult.cookies;
      }
    } else {
      // jscs:disable disallowEmptyBlocks
      // This is an API request. Cookies are not supported.
    }

    context.accept = parseAcceptHeader(request);

    context.eTagPrecondition = parsePreconditionHeader(request);

    context.additionalHeaders = [];
    WebSession.Context.headerWhitelist.forEach((headerName) => {
      if (request.headers[headerName]) {
        context.additionalHeaders.push({
          name: headerName,
          value: request.headers[headerName],
        });
      };
    });

    const promise = new Promise((resolve, reject) => {
      response.resolveResponseStream = resolve;
      response.rejectResponseStream = reject;
    });

    context.responseStream = new Capnp.Capability(promise, ByteStream);

    return context;
  }

  translateResponse(rpcResponse, response, request) {
    if (this.hostId) {
      if (rpcResponse.setCookies && rpcResponse.setCookies.length > 0) {
        response.setHeader("Set-Cookie", rpcResponse.setCookies.map(makeSetCookieHeader));
      }

      // Add a Content-Security-Policy header which:
      // (1) Allows the app to load resources from itself, including inline
      //     script and styles.
      // (2) Allows the app to connect back to itself over websockets.
      // (3) Allows the app to frame itself (in case the app uses frames) and the
      //     shell (for things like token templating).
      // (4) Prevents the app from initiating HTTP requests to third parties.
      // (5) Prevents the app from navigating the parent frame. (no allow-top-navigation)
      // (6) Prevents the app from opening popups. (no allow-popups)
      // (7) Prevents the app from locking the pointer (no allow-pointer-lock)
      // (8) Disables sending referrer when fetching or navigating to other resources.
      const ROOT_URL = Url.parse(process.env.ROOT_URL);
      let wsProtocol = undefined;
      if (ROOT_URL.protocol == "https") {
        wsProtocol = "wss";
      } else {
        wsProtocol = "ws";
      }

      const grainHost = makeWildcardHost(this.hostId);
      const cspRule = [
        "default-src 'self' " + wsProtocol + "://" + grainHost,
        "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
        "img-src data: 'self'",
        "style-src 'self' 'unsafe-inline'",
        "frame-src 'self' " + ROOT_URL.host,
        "sandbox allow-forms allow-scripts",
        "referrer no-referrer",
      ].join(" ; ");
      // The standard header name is Content-Security-Policy.
      response.setHeader("Content-Security-Policy", cspRule);
      // IE 10 and 11 require the X- prefix for CSP.
      response.setHeader("X-Content-Security-Policy", cspRule);
      // Some versions of Safari and the Blackberry browser only handle this
      // header under the name X-Webkit-CSP.
      response.setHeader("X-Webkit-CSP", cspRule);

      // Add an X-Frame-Options: header which prohibits anyone other than the
      // Sandstorm shell from framing the app (as a backup defense vs.
      // clickjacking, though unguessable hostnames already mostly prevent this).
      response.setHeader("X-Frame-Options", "allow-from " + ROOT_URL.href);
    } else {
      // jscs:disable validateQuoteMarks
      // This is an API request. Cookies are not supported.

      // We need to make sure caches know that different bearer tokens get totally different results.
      response.setHeader('Vary', 'Authorization');

      // APIs can be called from any origin. Because we ignore cookies, there is no security problem.
      response.setHeader('Access-Control-Allow-Origin', '*');

      // Add a Content-Security-Policy as a backup in case someone finds a way to load this resource
      // in a browser context. This policy should thoroughly neuter it.
      response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      const cspRule = "default-src 'none'; sandbox";
      response.setHeader("Content-Security-Policy", cspRule);
      response.setHeader("X-Content-Security-Policy", cspRule);
      response.setHeader("X-Webkit-CSP", cspRule);
    }

    // On first response, update the session to have hasLoaded=true
    this.setHasLoaded();

    // TODO(security): Set X-Content-Type-Options: nosniff?

    if ('content' in rpcResponse) {
      const content = rpcResponse.content;
      const code = successCodes[content.statusCode];
      if (!code) {
        throw new Error('Unknown status code: ', content.statusCode);
      }

      if (content.mimeType) {
        response.setHeader('Content-Type', content.mimeType);
      }

      if (content.encoding) {
        response.setHeader('Content-Encoding', content.encoding);
      }

      if (content.language) {
        response.setHeader('Content-Language', content.language);
      }

      if (content.eTag) {
        response.setHeader('ETag', composeETag(content.eTag));
      }

      if (('disposition' in content) && ('download' in content.disposition)) {
        response.setHeader('Content-Disposition', 'attachment; filename="' +
            content.disposition.download.replace(/([\\"\n])/g, "\\$1") + '"');
      }

      if ('stream' in content.body) {
        if (request.method === 'HEAD') {
          content.body.stream.close();
          response.rejectResponseStream(new Error('HEAD request; content doesn\'t matter.'));
        } else {
          const streamHandle = content.body.stream;
          response.writeHead(code.id, code.title);
          const promise = new Promise((resolve, reject) => {
            response.resolveResponseStream(new Capnp.Capability(
                new ResponseStream(response, streamHandle, resolve, reject), ByteStream));
          });
          promise.streamHandle = streamHandle;
          return promise;
        }
      } else {
        response.rejectResponseStream(
          new Error('Response content body was not a stream.'));

        if ('bytes' in content.body) {
          response.setHeader('Content-Length', content.body.bytes.length);
        } else {
          throw new Error('Unknown content body type.');
        }
      }

      response.writeHead(code.id, code.title);

      if ('bytes' in content.body && request.method !== 'HEAD') {
        response.write(content.body.bytes);
      }

      response.end();
    } else if ('noContent' in rpcResponse) {
      const noContent = rpcResponse.noContent;
      const noContentCode = noContentSuccessCodes[noContent.shouldResetForm * 1];
      response.writeHead(noContentCode.id, noContentCode.title);
      response.end();
    } else if ('preconditionFailed' in rpcResponse) {
      const preconditionFailed = rpcResponse.preconditionFailed;
      if (request.method === 'GET' && 'if-none-match' in request.headers) {
        if (preconditionFailed.matchingETag) {
          response.setHeader('ETag', composeETag(preconditionFailed.matchingETag));
        }

        response.writeHead(304, 'Not Modified');
      } else {
        response.writeHead(412, 'Precondition Failed');
      }

      response.end();
    } else if ('redirect' in rpcResponse) {
      const redirect = rpcResponse.redirect;
      const redirectCode = redirectCodes[redirect.switchToGet * 2 + redirect.isPermanent];
      response.writeHead(redirectCode.id, redirectCode.title, {
        'Location': redirect.location,
      });
      response.end();
    } else if ('clientError' in rpcResponse) {
      const clientError = rpcResponse.clientError;
      const errorCode = errorCodes[clientError.statusCode];
      if (!errorCode) {
        throw new Error('Unknown status code: ', clientError.statusCode);
      }

      response.writeHead(errorCode.id, errorCode.title, {
        'Content-Type': 'text/html',
      });

      if (request.method !== 'HEAD') {
        if (clientError.descriptionHtml) {
          response.write(clientError.descriptionHtml);
        } else {
          // TODO(someday):  Better default error page.
          response.write('<html><body><h1>' + errorCode.id + ': ' + errorCode.title +
                         '</h1></body></html>');
        }
      }

      response.end();
    } else if ('serverError' in rpcResponse) {
      response.writeHead(500, 'Internal Server Error', {
        'Content-Type': 'text/html',
      });

      if (request.method !== 'HEAD') {
        if (rpcResponse.serverError.descriptionHtml) {
          response.write(rpcResponse.serverError.descriptionHtml);
        } else {
          // TODO(someday):  Better default error page.
          response.write('<html><body><h1>500: Internal Server Error</h1></body></html>');
        }
      }

      response.end();
    } else {
      throw new Error('Unknown HTTP response type:\n' + JSON.stringify(rpcResponse));
    }

    return Promise.resolve(undefined);
  }

  handleRequest(request, data, response, retryCount) {
    const _this = this;
    return Promise.resolve(undefined).then(() => {
      return _this.makeContext(request, response);
    }).then((context) => {
      // jscs:disable requireDotNotation
      // Send the RPC.
      const path = request.url.slice(1);  // remove leading '/'
      const session = _this.getSession(request);

      const requestContent = () => {
        return {
          content: data,
          encoding: request.headers['content-encoding'],
          mimeType: request.headers['content-type'],
        };
      };

      const xmlContent = () => {
        const type = request.headers['content-type'] || 'application/xml;charset=utf-8';
        const match = type.match(/[^/]*\/xml(; *charset *= *([^ ;]*))?/);
        if (!match) {
          response.writeHead(415, 'Unsupported media type.', {
            'Content-Type': 'text/plain',
          });
          response.end('expected XML request body');
          throw new Error('expected XML request body');
        }

        const charset = match[2] || 'ISO-8859-1';

        const encoding = request.headers['content-encoding'];
        if (encoding && encoding !== 'identity') {
          if (encoding !== 'gzip') throw new Error('unknown Content-Encoding: ' + encoding);
          data = gunzipSync(data);
        }

        return data.toString(charset.toLowerCase() === 'utf-8' ? 'utf8' : 'binary');
      };

      const propfindDepth = () => {
        const depth = request.headers['depth'];
        return depth === '0' ? 'zero'
             : depth === '1' ? 'one'
                             : 'infinity';
      };

      const shallow = () => {
        return request.headers['depth'] === '0';
      };

      const noOverwrite = () => {
        return (request.headers['overwrite'] || '').toLowerCase() === 'f';
      };

      const destination = () => {
        const result = request.headers['destination'];
        if (!result) throw new Error('missing destination');
        return Url.parse(result).path.slice(1);  // remove leading '/'
      };

      if (request.method === 'GET' || request.method === 'HEAD') {
        return session.get(path, context, request.method === 'HEAD');
      } else if (request.method === 'POST') {
        return session.post(path, requestContent(), context);
      } else if (request.method === 'PUT') {
        return session.put(path, requestContent(), context);
      } else if (request.method === 'PATCH') {
        return session.patch(path, requestContent(), context);
      } else if (request.method === 'DELETE') {
        return session.delete(path, context);
      } else if (request.method === 'PROPFIND') {
        return session.propfind(path, xmlContent(), propfindDepth(), context);
      } else if (request.method === 'PROPPATCH') {
        return session.proppatch(path, xmlContent(), context);
      } else if (request.method === 'MKCOL') {
        return session.mkcol(path, requestContent(), context);
      } else if (request.method === 'COPY') {
        return session.copy(path, destination(), noOverwrite(), shallow(), context);
      } else if (request.method === 'MOVE') {
        return session.move(path, destination(), noOverwrite(), context);
      } else if (request.method === 'LOCK') {
        return session.lock(path, xmlContent(), shallow(), context);
      } else if (request.method === 'UNLOCK') {
        return session.unlock(path, request.headers['lock-token'], context);
      } else if (request.method === 'ACL') {
        return session.acl(path, xmlContent(), context);
      } else if (request.method === 'REPORT') {
        return session.report(path, requestContent(), context);
      } else if (request.method === 'OPTIONS') {
        return session.options(path, context).then((options) => {
          const dav = [];
          if (options.davClass1) dav.push('1');
          if (options.davClass2) dav.push('2');
          if (options.davClass3) dav.push('3');
          if (options.davExtensions) {
            options.davExtensions.forEach((token) => {
              if (token.match(/^([a-zA-Z0-9!#$%&'*+.^_`|~-]+|<[\x21-\x7E]*>)$/)) {
                dav.push(token);
              }
            });
          }

          if (dav.length > 0) {
            response.setHeader("DAV", dav.join(", "));
            response.setHeader("Access-Control-Expose-Headers", "DAV");
          }

          response.end();
          // Return no response; we already handled everything.
        }, (err) => {
          if (err.kjType !== 'unimplemented') throw err;
          response.end();
          // Return no response; we already handled everything.
        });
      } else {
        throw new Error('Sandstorm only supports the following methods: GET, POST, PUT, PATCH, DELETE, HEAD, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK, ACL, REPORT, and OPTIONS.');
      }
    }).then((rpcResponse) => {
      if (rpcResponse !== undefined) {  // Will be undefined for OPTIONS request.
        return _this.translateResponse(rpcResponse, response, request);
      }
    }).catch((error) => {
      return _this.maybeRetryAfterError(error, retryCount).then(() => {
        return _this.handleRequest(request, data, response, retryCount + 1);
      });
    });
  }

  handleRequestStreaming(request, response, contentLength, retryCount) {
    const _this = this;
    const context = this.makeContext(request, response);
    const path = request.url.slice(1);  // remove leading '/'
    const session = this.getSession(request);

    const mimeType = request.headers['content-type'] || 'application/octet-stream';
    const encoding = request.headers['content-encoding'];

    let requestStreamPromise;
    if (request.method === 'POST') {
      requestStreamPromise = session.postStreaming(path, mimeType, context, encoding);
    } else if (request.method === 'PUT') {
      requestStreamPromise = session.putStreaming(path, mimeType, context, encoding);
    } else {
      throw new Error('Sandstorm only supports streaming POST and PUT requests.');
    }

    // TODO(perf): We ought to be pipelining the body, but we can't currently, because we have to
    //   handle the case where the app doesn't actually support streaming. We could pipeline while
    //   also buffering the data on the side in case we need it again later, but that's kind of
    //   complicated. We should fix the whole protocol to make streaming the standard.
    return requestStreamPromise.then((requestStreamResult) => {
      const requestStream = requestStreamResult.stream;

      // Initialized when getResponse() returns, if the response is streaming.
      let downloadStreamHandle;

      // Initialized if an upload-stream method throws.
      let uploadStreamError;

      // We call `getResponse()` immediately so that the app can start streaming data down even while
      // data is still being streamed up. This theoretically allows apps to perform bidirectional
      // streaming, though probably very few actually do that.
      //
      // Note that we need to be able to cancel `responsePromise` below, so it's important that it is
      // the raw Cap'n Proto promise. Hence `translateResponsePromise` is a separate variable.
      const responsePromise = requestStream.getResponse();

      const reportUploadStreamError = (err) => {
        // Called when an upload-stream method throws.

        if (!uploadStreamError) {
          uploadStreamError = err;

          // If we're still waiting on any response stuff, cancel it.
          responsePromise.cancel();
          requestStream.close();
          if (downloadStreamHandle) {
            downloadStreamHandle.close();
          }
        }
      };

      // If we have a Content-Length, pass it along to the app by calling `expectSize()`.
      if (contentLength !== undefined) {
        requestStream.expectSize(contentLength).catch((err) => {
          // expectSize() is allowed to be unimplemented.
          if (err.kjType !== 'unimplemented') {
            reportUploadStreamError(err);
          }
        });
      }

      // Pipe the input stream to the app.
      request.on('data', (buf) => {
        // TODO(soon): Only allow a small number of write()s to be in-flight at once,
        //   pausing the input stream if we hit that limit, so that we block the TCP socket all the
        //   way back to the source. May want to also coalesce small writes for this purpose.
        // TODO(security): The above problem may allow a DoS attack on the front-end.
        if (!uploadStreamError) requestStream.write(buf).catch(reportUploadStreamError);
      });

      request.on('end', () => {
        if (!uploadStreamError) requestStream.done().catch(reportUploadStreamError);

        // We're all done making calls to requestStream.
        requestStream.close();
      });

      request.on('close', () => {
        reportUploadStreamError(new Error('HTTP connection unexpectedly closed during request.'));
      });

      request.on('error', (err) => {
        reportUploadStreamError(err);
      });

      return responsePromise.then((rpcResponse) => {
        // Stop here if the upload stream has already failed.
        if (uploadStreamError) throw uploadStreamError;
        const promise = _this.translateResponse(rpcResponse, response, request);
        downloadStreamHandle = promise.streamHandle;
        return promise;
      });
    }, (err) => {
      if (err.kjType === 'failed' && err.message.indexOf('not implemented') !== -1) {
        // Hack to work around old apps using an old version of Cap'n Proto, before the
        // 'unimplemented' exception type was introduced. :(
        // TODO(cleanup): When we transition to API version 2, we can move this into the
        //   compatibility layer.
        err.kjType = 'unimplemented';
      }

      if (SandstormBackend.shouldRestartGrain(err, 0)) {
        // This is the kind of error that indicates we should retry. Note that we passed 0 for the
        // retry count above because we were just checking if this is a retriable error (vs. possibly
        // a method-not-implemented error); maybeRetryAfterError() will check again with the proper
        // retry count.
        return _this.maybeRetryAfterError(err, retryCount).then(() => {
          return _this.handleRequestStreaming(request, response, contentLength, retryCount + 1);
        });
      } else if (err.kjType === 'unimplemented') {
        // Streaming is not implemented. Fall back to non-streaming version.
        return readAll(request).then((data) => {
          return _this.handleRequest(request, data, response, 0);
        });
      } else {
        throw err;
      }
    });
  }

  handleWebSocket(request, socket, head, retryCount) {
    const _this = this;

    return Promise.resolve(undefined).then(() => {
      return _this.makeContext(request);
    }).then((context) => {
      const path = request.url.slice(1);  // remove leading '/'
      const session = _this.getSession(request);

      if (!('sec-websocket-key' in request.headers)) {
        throw new Error('Missing Sec-WebSocket-Accept header.');
      }

      const magic = request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
      const acceptKey = Crypto.createHash('sha1').update(magic).digest('base64');

      let protocols = [];
      if ('sec-websocket-protocol' in request.headers) {
        protocols = request.headers['sec-websocket-protocol']
            .split(',').map((s) => { return s.trim(); });
      }

      const receiver = new WebSocketReceiver(socket);

      const promise = session.openWebSocket(path, context, protocols, receiver);

      if (head.length > 0) {
        promise.serverStream.sendBytes(head);
      }

      const socketIdx = _this.websocketCounter.toString();
      _this.websockets[socketIdx] = socket;
      _this.websocketCounter += 1;
      pumpWebSocket(socket, promise.serverStream, () => { delete _this.websockets[socketIdx]; });

      return promise.then((response) => {
        const headers = [
            'HTTP/1.1 101 Switching Protocols',
            'Upgrade: websocket',
            'Connection: Upgrade',
            'Sec-WebSocket-Accept: ' + acceptKey,
        ];
        if (response.protocol && response.protocol.length > 0) {
          headers.push('Sec-WebSocket-Protocol: ' + response.protocol.join(', '));
        }

        headers.push('');
        headers.push('');

        socket.write(headers.join('\r\n'));
        receiver.go();

        // Note:  At this point errors are out of our hands.
      });
    }).catch((error) => {
      return _this.maybeRetryAfterError(error, retryCount).then(() => {
        return _this.handleWebSocket(request, socket, head, retryCount + 1);
      });
    });
  }

  setHasLoaded() {
    if (!this.hasLoaded) {
      this.hasLoaded = true;
      const sessionId = this.sessionId;
      inMeteor(() => {
        Sessions.update({ _id: sessionId }, { $set: { hasLoaded: true } });
      });
    }
  }
};

const PROTOCOL = Url.parse(process.env.ROOT_URL).protocol;

const isRfc1918OrLocal = (address) => {
  if (Net.isIPv4(address)) {
    quad = address.split('.').map((x) => { return parseInt(x, 10); });
    return (quad[0] === 127 || quad[0] === 10 ||
            (quad[0] === 192 && quad[1] === 168) ||
            (quad[0] === 172 && quad[1] >= 16 && quad[1] < 32));
  } else if (Net.isIPv6(address)) {
    // IPv6 specifies ::1 as localhost and fd:: as reserved for private networks
    return (address === '::1' || address.lastIndexOf('fd', 0) === 0);
  } else {
    // Ignore things that are neither IPv4 nor IPv6
    return false;
  }
};

const quadToIntString = (quad) => {
  const num = Bignum(quad[0]).shiftLeft(16)
              .add(quad[1]).shiftLeft(16)
              .add(quad[2]).shiftLeft(16)
              .add(quad[3]);
  return num.toString();
};

// -----------------------------------------------------------------------------
// Session cookie management

const parseCookies = (request) => {
  // jscs:disable requireDotNotation
  const header = request.headers['cookie'];

  const result = { cookies: [] };
  if (header) {
    const reqCookies = header.split(';');
    for (const i in reqCookies) {
      const reqCookie = reqCookies[i];
      const equalsPos = reqCookie.indexOf('=');
      let cookie;
      if (equalsPos === -1) {
        cookie = { key: reqCookie.trim(), value: '' };
      } else {
        cookie = { key: reqCookie.slice(0, equalsPos).trim(), value: reqCookie.slice(equalsPos + 1) };
      }

      if (cookie.key === 'sandstorm-sid') {
        if (result.sessionId) {
          throw new Error('Multiple sandstorm session IDs?');
        }

        result.sessionId = cookie.value;
      } else {
        result.cookies.push(cookie);
      }
    }
  }

  return result;
};

const parsePreconditionHeader = (request) => {
  if (request.headers['if-match']) {
    if (request.headers['if-match'].trim() === '*') {
      return { exists: null };
    }

    const matches = parseETagList(request.headers['if-match']);
    if (matches.length > 0) {
      return { matchesOneOf: matches };
    }
  }

  if (request.headers['if-none-match']) {
    if (request.headers['if-none-match'].trim() === '*') {
      return { doesntExist: null };
    }

    const noneMatches = parseETagList(request.headers['if-none-match']);
    if (noneMatches.length > 0) {
      return { matchesNoneOf: noneMatches };
    }
  }

  return { none: null };
};

const parseETagList = (input) => {
  // An ETag is a quoted, \-escaped string, possibly prefixed with W/ (outside the quotes) to
  // indicate that it is weak. We are parsing a list of comma-delimited etags.

  input = input.trim();
  const results = [];

  while (input.length > 0) {
    const match = input.match(/^\s*(W\/)?"(([^"\\]|\\.)*)"\s*($|,)/);
    if (!match) throw new Meteor.Error(400, 'invalid etag');

    input = input.slice(match[0].length).trim();
    results.push({ weak: !!match[1], value: match[2].replace(/\\(.)/g, '$1') });
  }

  return results;
};

const composeETag = (tag) => {
  let result = '"' + (tag.value || '').replace(/([\\"])/g, '\\$1') + '"';
  if (tag.weak) result = 'W/' + result;
  return result;
};

const parseAcceptHeader = (request) => {
  // jscs:disable requireDotNotation
  const header = request.headers['accept'];

  const result = [];
  if (header) {
    const acceptList = header.split(',');
    for (const i in acceptList) {
      const acceptStr = acceptList[i];
      const tokensList = acceptStr.split(';');

      const temp = { mimeType: tokensList[0].trim() };

      const tokensListRest = tokensList.slice(1);
      for (const j in tokensListRest) {
        const token = tokensListRest[j];
        const equalsPos = token.indexOf('=');
        if (equalsPos) {
          const key = token.slice(0, equalsPos).trim();
          const value = token.slice(equalsPos + 1).trim();

          if (key === 'q') {
            temp.qValue = +value;
          }
        }
      }

      result.push(temp);
    }
  }

  return result;
};

// -----------------------------------------------------------------------------
// Regular HTTP request handling

const readAll = (stream) => {
  return new Promise((resolve, reject) => {
    const buffers = [];
    stream.on('data', (buf) => {
      buffers.push(buf);
    });

    stream.on('end', () => {
      resolve(Buffer.concat(buffers));
    });

    stream.on('error', reject);
  });
};

const makeSetCookieHeader = (cookie) => {
  const result = [cookie.name, '=', cookie.value];

  if ('absolute' in cookie.expires) {
    result.push('; Expires=');
    result.push(new Date(cookie.expires.absolute * 1000).toUTCString());
  } else if ('relative' in cookie.expires) {
    result.push('; Max-Age=' + cookie.expires.relative);
  }

  if (cookie.path) {
    result.push('; Path=' + cookie.path);
  }

  if (cookie.httpOnly) {
    result.push('; HttpOnly');
  }

  return result.join('');
};

// TODO(cleanup):  Auto-generate based on annotations in web-session.capnp.
const successCodes = {
  ok:          { id: 200, title: 'OK' },
  created:     { id: 201, title: 'Created' },
  accepted:    { id: 202, title: 'Accepted' },
  multiStatus: { id: 207, title: 'Multi-Status' },
};
const noContentSuccessCodes = [
  // Indexed by shouldResetForm * 1
  { id: 204, title: 'No Content' },
  { id: 205, title: 'Reset Content' },
];
const redirectCodes = [
  // Indexed by switchToGet * 2 + isPermanent
  { id: 307, title: 'Temporary Redirect' },
  { id: 308, title: 'Permanent Redirect' },
  { id: 303, title: 'See Other' },
  { id: 301, title: 'Moved Permanently' },
];
const errorCodes = {
  badRequest:            { id: 400, title: 'Bad Request' },
  forbidden:             { id: 403, title: 'Forbidden' },
  notFound:              { id: 404, title: 'Not Found' },
  methodNotAllowed:      { id: 405, title: 'Method Not Allowed' },
  notAcceptable:         { id: 406, title: 'Not Acceptable' },
  conflict:              { id: 409, title: 'Conflict' },
  gone:                  { id: 410, title: 'Gone' },
  requestEntityTooLarge: { id: 413, title: 'Request Entity Too Large' },
  requestUriTooLong:     { id: 414, title: 'Request-URI Too Long' },
  unsupportedMediaType:  { id: 415, title: 'Unsupported Media Type' },
  imATeapot:             { id: 418, title: 'I\'m a teapot' },
  unprocessableEntity:   { id: 422, title: 'Unprocessable Entity' },
};

ResponseStream = class ResponseStream {
  constructor(response, streamHandle, resolve, reject) {
    this.response = response;
    this.streamHandle = streamHandle;
    this.resolve = resolve;
    this.reject = reject;
    this.ended = false;
  }

  write(data) {
    this.response.write(data);
  }

  done() {
    this.response.end();
    this.streamHandle.close();
    this.ended = true;
  }

  close() {
    if (this.ended) {
      this.resolve();
    } else {
      this.streamHandle.close();
      this.reject(new Error('done() was never called on outbound stream.'));
    }
  }
};

// TODO(cleanup): Node 0.12 has a `gunzipSync` but 0.10 (which Meteor still uses) does not.
const Zlib = Npm.require('zlib');
const gunzipSync = Meteor.wrapAsync(Zlib.gunzip, Zlib);

// -----------------------------------------------------------------------------
// WebSocket handling

WebSocketReceiver = class WebSocketReceiver {
  constructor(socket) {
    this.socket = socket;
    this.queue = [];
  }

  go() {
    for (let i in this.queue) {
      this.socket.write(this.queue[i]);
    }

    this.queue = null;
  }

  sendBytes(message) {
    // TODO(someday):  Flow control of some sort?
    if (this.queue === null) {
      this.socket.write(message);
    } else {
      this.queue.push(message);
    }
  }

  close() {
    this.socket.end();
  }
};

pumpWebSocket = (socket, rpcStream, destructor) => {
  socket.on('data', (chunk) => {
    rpcStream.sendBytes(chunk).catch((err) => {
      if (err.kjType !== 'disconnected') {
        console.error('WebSocket sendBytes failed: ' + err.stack);
      }

      socket.destroy();
    });
  });

  socket.on('end', (chunk) => {
    rpcStream.close();
  });

  socket.on("close", () => {
    destructor();
  });
};

// =======================================================================================
// Debug log access

Meteor.publish('grainLog', function (grainId) {
  check(grainId, String);
  let id = 0;
  const grain = Grains.findOne(grainId);
  if (!grain || !this.userId || grain.userId !== this.userId) {
    this.added('grainLog', id++, { text: 'Only the grain owner can view the debug log.' });
    this.ready();
    return;
  }

  let connected = false;
  const _this = this;

  const receiver = {
    write(data) {
      connected = true;
      _this.added('grainLog', id++, { text: data.toString('utf8') });
    },

    close() {
      if (connected) {
        _this.added('grainLog', id++, {
          text: '*** lost connection to grain (probably because it shut down) ***',
        });
      }
    },
  };

  try {
    const handle = waitPromise(globalBackend.useGrain(grainId, (supervisor) => {
      return supervisor.watchLog(8192, receiver);
    })).handle;
    connected = true;
    this.onStop(() => {
      handle.close();
    });
  } catch (err) {
    if (!connected) {
      this.added('grainLog', id++, {
        text: '*** couldn\'t connect to grain (' + err + ') ***',
      });
    }
  }

  // Notify ready.
  this.ready();
});
