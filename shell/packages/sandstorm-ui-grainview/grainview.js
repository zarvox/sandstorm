// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2016 Sandstorm Development Group, Inc. and contributors
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

let counter = 0;

// Pseudo-collection, published in shell/server/grain-server.js.
GrainSizes = new Mongo.Collection("grainSizes");

GrainView = class GrainView {
  constructor(grains, db, grainId, path, tokenInfo, parentElement) {
    // `path` starts with a slash and includes the query and fragment.
    //
    // Owned grains:
    // grainId, path, dep.
    //   callback sets error, openingSession on failure,
    //                 grainId, sessionId, sessionSub on success.
    //
    // Sturdyref ApiTokens:
    // grainId, path, dep.
    //   callback sets error, openingSession on failure
    //                 grainId, sessionId, sessionSub on success.
    //
    // Token-only sessions:
    // grainId, token, path, dep
    //   callback sets error, openingSession on failure
    //                 grainId, sessionId, title, and session Sub on success

    check(grains, GrainViewList);
    check(db, SandstormDb);
    if (Tracker.active) {
      throw new Error("Can't construct a GrainView inside a reactive computation.");
    }

    this._grains = grains;
    this._db = db;
    this._grainId = grainId;
    this._originalPath = path;
    this._path = path;
    this._tokenInfo = tokenInfo;
    this._token = tokenInfo && tokenInfo._id;
    this._parentElement = parentElement;
    this._status = "closed";
    this._dep = new Tracker.Dependency();

    this._powerboxRequest = new ReactiveVar(undefined);
    this._permissionRequests = new ReactiveVar([]);

    this._userIdentityId = new ReactiveVar(undefined);
    // `false` means incognito; `undefined` means we still need to decide whether to reveal
    // an identity.

    if (this._tokenInfo && this._tokenInfo.webkey) {
      if (!Meteor.userId()) {
        this.doNotRevealIdentity();
      }

      const disallowGuests = globalDb.getOrganizationDisallowGuests();
      if (disallowGuests) {
        // If guests are disallowed, we can skip the interstitial if there's only 1 identitiy.
        const user = Meteor.user();
        if (user.loginIdentities.length === 1 && user.nonloginIdentities.length === 0) {
          this.revealIdentity(user.loginIdentities[0].id);
        }
      }
    } else {
      this.revealIdentity();
    }

    // We manage our Blaze view directly in order to get more control over when iframes get
    // re-rendered. E.g. if we were to instead use a template with {{#each grains}} iterating over
    // the list of open grains, all grains might get re-rendered whenever a grain is removed from the
    // list, which would reset all the iframe states, making users sad.
    this._blazeView = Blaze.renderWithData(Template.grainView, this, parentElement);

    this.id = counter++;

    // Whenever a dev package is published or removed, reset the view.
    this._devAppObserver = Tracker.autorun(() => {
      const grain = this._db.getGrain(grainId);

      let devApp;
      if (grain) {
        devApp = grain && this._db.collections.devPackages.findOne({ appId: grain.appId });
      } else {
        // Probably, we aren't the owner of the grain. In this case we actually intentionally
        // cannot determine the grain's appId, so we have to heuristically use appTitle instead.
        // TODO(someday): This still doesn't work for anonymous users since they don't have any
        //   denormalized grain metadata! But if we fix that bug this should suddenly work.
        devApp = this._db.collections.devPackages.findOne({
          "manifest.appTitle.defaultText": this.appTitle(),
        });
      }

      const id = devApp ? devApp._id : "none";
      if (this._devAppId !== id) {
        if (this._status !== "closed") {
          this.reset(this.identityId());
          this.openSession();
        }
      }

      this._devAppId = id;
    });
  }

  save() {
    // Returns a JSON-able argument array that can be passed to GrainView's constructor to
    // reconstruct the same view later. However, the parentElement argument can't be included
    // since it is a live object, not data.

    return [this._grainId, this._path, this._tokenInfo];
  }

  reset(identityId) {
    // TODO(cleanup): This duplicates some code from the GrainView constructor.

    this._dep.changed();
    this.destroy(true);
    this._hasLoaded = undefined;
    this._error = undefined;
    this._hostId = undefined;
    this._sessionId = null;
    this._sessionSalt = null;

    this._grainSizeSub = undefined;
    this._sessionObserver = undefined;
    this._sessionSub = undefined;

    this._status = "closed";
    this._userIdentityId = new ReactiveVar(undefined);
    if (identityId) {
      this.revealIdentity(identityId);
    }
    // We want the iframe to receive the most recently-set path whenever we rerender.
    this._originalPath = this._path;
    this._blazeView = Blaze.renderWithData(Template.grainView, this, this._parentElement);
  }

  switchIdentity(identityId) {
    check(identityId, String);
    const currentIdentityId = this.identityId();
    const grainId = this.grainId();
    if (currentIdentityId === identityId) return;
    const _this = this;
    if (this._status === "error") {
      // This case applies when the user switches their identity before clicking on the
      // "request access" button.
      this._userIdentityId.set(identityId);
    } else if (this._token) {
      // We're currently viewing the grain incognito.
      _this.reset(identityId);
      _this.openSession();
    } else if (this.isOwner()) {
      Meteor.call("updateGrainPreferredIdentity", grainId, identityId, (err, result) => {
        if (err) {
          console.log("error:", err);
        } else {
          _this.reset(identityId);
          _this.openSession();
        }
      });
    } else {
      if (this._db.collections.apiTokens.findOne({
        grainId: grainId,
        "owner.user.identityId": identityId,
        revoked: { $ne: true },
      })) {
        // just do the switch
        _this.reset(identityId);
        _this.openSession();
      } else {
        // Should we maybe prompt the user first?
        //  'That identity does not already have access to this grain. Would you like to share access
        //   from your current identity? Y/ cancel.'
        Meteor.call("newApiToken",
            { identityId: currentIdentityId },
            grainId,
            "direct share",
            { allAccess: null },
            { user: { identityId: identityId, title: _this.title() } },
            (err, result) => {
              if (err) {
                console.log("error:", err);
              } else {
                _this.reset(identityId);
                _this.openSession();
              }
            }
        );
      }
    }
  }

  destroy(forReset) {
    // This must be called when the GrainView is removed from the list otherwise Blaze will go on
    // rendering the iframe forever, even if it is no longer linked into the page DOM.

    Blaze.remove(this._blazeView);
    if (this._grainSizeSub) {
      this._grainSizeSub.stop();
    }

    if (this._sessionObserver) {
      this._sessionObserver.stop();
    }

    if (this._sessionSub) {
      this._sessionSub.stop();
    }

    if (this._devAppObserver && !forReset) {
      this._devAppObserver.stop();
    }
  }

  isActive() {
    this._dep.depend();
    return this._isActive;
  }

  setActive(isActive) {
    this._isActive = isActive;
    this._dep.changed();
  }

  isOldSharingModel() {
    this._dep.depend();
    const grain = this._db.getGrain(this._grainId);
    return grain && !grain.private;
  }

  isOwner() {
    this._dep.depend();
    // See if this is one of our own grains.
    // If we're not logged in, we can't be the owner.
    if (!Meteor.userId()) return false;
    const grain = this._db.collections.grains.findOne({ _id: this._grainId,
                                                        userId: Meteor.userId(), });
    return grain != undefined;
  }

  _isUsingAnonymously() {
    this._dep.depend();
    if (this.isOldSharingModel()) {
      return false;
    }

    if (!Meteor.userId() && !this._token) {
      console.error("should never happen: anonymous, but no token either.");
    }

    return !!this._token;
  }

  size() {
    const size = GrainSizes.findOne(this._grainId);
    return size && size.size;
  }

  title() {
    return this.fullTitle().title;
  }

  fullTitle() {
    // Returns the user's name for this grain, not the browser tab title.
    // Three cases:
    // 1) We own the grain or it is public. Use the value from the Grains collection.
    // 2) We own an ApiToken for the grain.  Use the value from the ApiTokens collection.
    // 3) We are using an ApiToken for the grain.  Use the transient value stored in this._title.
    this._dep.depend();
    if (this.isOwner() || this.isOldSharingModel()) {
      // Case 1.
      const grain = this._db.getGrain(this._grainId);
      return { title: grain && grain.title };
    } else if (!this._isUsingAnonymously()) {
      // Case 2.
      const apiToken = this._db.collections.apiTokens.findOne({
        grainId: this._grainId,
        "owner.user.identityId": this.identityId(),
      }, {
        sort: { created: 1 },
      });

      if (!apiToken) {
        return { title: undefined };
      }

      const info = apiToken.owner.user;
      if (!info.upstreamTitle) {
        return { title: info.title };
      } else if (info.renamed) {
        return { title: info.title, renamedFrom: info.upstreamTitle };
      } else {
        return { title: info.upstreamTitle, was: info.title };
      }
    } else {
      // Case 3.
      // TODO(someday): We don't show info about renames in this case, but we probably should.
      //   Requires threading through info from the server.
      return { title: this._title };
    }
  }

  appTitle() {
    // Three cases:
    // 1) We own the grain.  Look up the app title in the package manifest.
    // 2) We own an ApiToken for the grain.  Use the value from the denormalizedGrainMetadata.
    // 3) We are using an ApiToken for the grain (either logged out or incognito).  Use the value
    //    from the TokenInfo pseudocollection.
    this._dep.depend();
    if (this.isOwner()) {
      // Case 1.
      const grain = this._db.getGrain(this._grainId);
      const pkg = grain && this._db.collections.packages.findOne({ _id: grain.packageId });
      return pkg && pkg.manifest && pkg.manifest.appTitle && pkg.manifest.appTitle.defaultText;
    } else if (!this._isUsingAnonymously()) {
      // Case 2
      const token = this._db.collections.apiTokens.findOne({
        grainId: this._grainId,
        "owner.user.identityId": this.identityId(),
      }, {
        sort: { created: 1 },
      });

      return (token && token.owner && token.owner.user && token.owner.user.denormalizedGrainMetadata &&
        token.owner.user.denormalizedGrainMetadata.appTitle.defaultText);
      // TODO(someday) - shouldn't use defaultText
    } else {
      // Case 3
      const tokenInfo = this._tokenInfo;
      return tokenInfo && tokenInfo.grainMetadata && tokenInfo.grainMetadata.appTitle &&
             tokenInfo.grainMetadata.appTitle.defaultText;
      // TODO(someday) - shouldn't use defaultText
    }
  }

  frameTitle() {
    this._dep.depend();
    if (this._frameTitle !== undefined) {
      return this._frameTitle + " · " + globalDb.getServerTitle();
    }

    const appTitle = this.appTitle();
    const grainTitle = this.title();
    // Actually set the values
    if (appTitle && grainTitle) {
      return grainTitle + " · " + appTitle + " · " + globalDb.getServerTitle();
    } else if (grainTitle) {
      return grainTitle + " · " + globalDb.getServerTitle();
    } else {
      return globalDb.getServerTitle();
    }
  }

  updateDocumentTitle() {
    this._dep.depend();
    document.title = this.frameTitle();
  }

  error() {
    this._dep.depend();
    return this._error;
  }

  hasLoaded() {
    this._dep.depend();
    if (this._hasLoaded) {
      return true;
    }

    const session = Sessions.findOne({ _id: this._sessionId });
    // TODO(soon): this is a hack to cache hasLoaded. Consider moving it to an autorun.
    this._hasLoaded = session && session.hasLoaded;

    return this._hasLoaded;
  }

  origin() {
    this._dep.depend();
    return this._hostId && (window.location.protocol + "//" + makeWildcardHost(this._hostId));
  }

  viewInfo() {
    this._dep.depend();
    return this._viewInfo;
  }

  grainId() {
    this._dep.depend();
    return this._grainId;
  }

  sessionId() {
    this._dep.depend();
    return this._sessionId;
  }

  setTitle(newTitle) {
    this._title = newTitle;
    if (this._userIdentityId.get()) {
      Meteor.call("updateGrainTitle", this._grainId, newTitle, this._userIdentityId.get());
    }

    this._dep.changed();
  }

  setPath(newPath) {
    this._path = newPath;
    if (this.isActive()) {
      window.history.replaceState({}, "", this.route());
    }

    this._dep.changed();
  }

  depend() {
    this._dep.depend();
  }

  revealIdentity(identityId) {
    if (!Meteor.user()) {
      return;
    }

    const myIdentityIds = SandstormDb.getUserIdentityIds(Meteor.user());
    let resultIdentityId = myIdentityIds[0];
    const grain = this._db.getGrain(this._grainId);
    if (identityId && myIdentityIds.indexOf(identityId) != -1) {
      resultIdentityId = identityId;
    } else if (grain && myIdentityIds.indexOf(grain.identityId) != -1) {
      // If we own the grain, open it as the owning identity.
      resultIdentityId = grain.identityId;
    } else {
      const token = this._db.collections.apiTokens.findOne({
        grainId: this._grainId,
        "owner.user.identityId": { $in: myIdentityIds },
      }, {
        sort: { lastUsed: -1 },
      });

      if (token) {
        resultIdentityId = token.owner.user.identityId;
      }
    }

    this._userIdentityId.set(resultIdentityId);
    this._dep.changed();
  }

  doNotRevealIdentity() {
    this._userIdentityId.set(false);
    this._dep.changed();
  }

  identityId() {
    this._dep.depend();
    const identityId = this._userIdentityId.get();
    if (identityId) {
      return identityId;
    } else {
      return null;
    }
  }

  shouldShowInterstitial() {
    this._dep.depend();
    // We only show the interstitial for /shared/ routes.
    if (!this._tokenInfo) {
      return null;
    }

    if (this._tokenInfo.webkey) {
      // If we have explictly set _userIdentityId, we don't need to show the interstitial.
      if (this._userIdentityId.get() !== undefined) {
        return null;
      }

      // If we are not logged in, we don't need to show the interstitial - we'll go incognito by
      // default.
      if (!Meteor.userId()) {
        return null;
      }

      // Otherwise, we should show it.
      return {
        chooseIdentity: {},
        showIncognito: !globalDb.getOrganizationDisallowGuests(),
      };
    } else {
      throw new Error("unrecognized tokenInfo: ", this._tokenInfo);
    }
  }

  _redirectFromShareLink() {
    // We should remove this tab from the tab list, since the /grain/<grainId> route
    // will set up its own tab for this grain.  There could even already be a tab open, if the
    // user reuses a /shared/ link.

    this._grains.remove(this._grainId, false);
    Router.go("/grain/" + this._tokenInfo.grainId + this._path, {},
              { replaceState: true });
  }

  _addSessionObserver(sessionId) {
    const _this = this;
    _this._sessionSub = Meteor.subscribe("sessions", sessionId);
    _this._sessionObserver = Sessions.find({ _id: sessionId }).observe({
      removed(session) {
        _this._sessionSub.stop();
        _this._sessionSub = undefined;
        _this._status = "closed";
        _this._dep.changed();
        if (_this._sessionObserver) {
          _this._sessionObserver.stop();
        }

        Meteor.defer(() => { _this.openSession(); });
      },

      changed(session) {
        _this._viewInfo = session.viewInfo || _this._viewInfo;
        _this._permissions = session.permissions || _this._permissions;
        _this._dep.changed();
      },

      added(session) {
        _this._viewInfo = session.viewInfo || _this._viewInfo;
        _this._permissions = session.permissions || _this._permissions;
        _this._status = "opened";
        _this._dep.changed();
      },
    });

  }

  _openGrainSession() {
    const _this = this;
    const identityId = _this.identityId();

    const condition = () => {
      // Make sure we don't call openSession before the user is logged in.
      // Legacy shares don't have an identityId.
      return !identityId || (Meteor.userId() && !Meteor.loggingIn());
    };

    onceConditionIsTrue(condition, () => {
      Meteor.call("openSession", _this._grainId, identityId, _this._sessionSalt, (error, result) => {
        if (error) {
          console.error("openSession error", error);
          _this._error = error;
          _this._status = "error";
          _this._dep.changed();
        } else {
          // result is an object containing sessionId, initial title, and grainId.
          if (result.title) {
            _this._title = result.title;
          }

          _this._grainId = result.grainId;
          _this._sessionId = result.sessionId;
          _this._hostId = result.hostId;
          _this._sessionSalt = result.salt;

          _this._addSessionObserver(result.sessionId);

          if (_this._grainSizeSub) _this._grainSizeSub.stop();
          _this._grainSizeSub = Meteor.subscribe("grainSize", result.grainId);
          _this._dep.changed();
        }
      });
    });
  }

  _openApiTokenSession() {
    const _this = this;
    const condition = () => {
      return _this._tokenInfo.webkey && _this._userIdentityId.get() !== undefined;
    };

    onceConditionIsTrue(condition, () => {
      const identityId = _this.identityId();
      const openSessionArg = {
        token: _this._token,
        incognito: !identityId,
      };
      Meteor.call("openSessionFromApiToken",
        openSessionArg, identityId, _this._sessionSalt, (error, result) => {
          if (error) {
            console.error("openSessionFromApiToken error", error);
            _this._error = error;
            _this._status = "error";
            _this._dep.changed();
          } else if (result.redirectToGrain) {
            _this._grainId = result.redirectToGrain;
            _this._dep.changed();

            return _this._redirectFromShareLink();
          } else {
            // We are viewing this via just the /shared/ link, either as an anonymous user on in our
            // incognito mode (since we'd otherwise have redeemed the token and been redirected).
            _this._title = result.title;
            _this._grainId = result.grainId;
            _this._sessionId = result.sessionId;
            _this._hostId = result.hostId;
            _this._sessionSalt = result.salt;
            _this._addSessionObserver(result.sessionId);
            _this._dep.changed();
          }
        }
      );
    });
  }

  openSession() {
    if (this._status !== "closed") {
      console.error("GrainView: openSession() called but state was " + this._status);
      return;
    }

    this._status = "opening";
    if (!this._token) {
      // Opening a grain session.
      this._openGrainSession();
    } else {
      // Opening an ApiToken session.  Only do so if we don't need to show the interstitial first.
      this._openApiTokenSession();
    }
  }

  sessionStatus() {
    // 'opening', 'opened', 'closed'
    this._dep.depend();
    return this._status;
  }

  route() {
    this._dep.depend();
    if (this._token) {
      return "/shared/" + this._token + this._path;
    } else {
      return "/grain/" + this._grainId + this._path;
    }
  }

  _fallbackIdenticon() {
    // identifier is SHA1('');
    return Identicon.identiconForApp("da39a3ee5e6b4b0d3255bfef95601890afd80709", "grain");
  }

  _urlForAsset(assetId) {
    return window.location.protocol + "//" + makeWildcardHost("static") + "/" + assetId;
  }

  iconSrc() {
    // Several options here:
    // 1. We own the grain.  Look up the icon metadata in the Package manifest (or DevPackage if applicable).
    // 2. We own an Api token for the grain.  Use the denormalizedGrainMetadata.
    // 3. We're using an ApiToken anonymously.  Use the data from the TokenInfo pseudocollection.
    this._dep.depend();
    if (this.isOwner()) {
      // Case 1
      const grain = this._db.getGrain(this._grainId);
      if (grain) {
        const pkg = this._db.collections.devPackages.findOne({ appId: grain.appId }) ||
                  this._db.collections.packages.findOne({ _id: grain.packageId });
        if (pkg) return Identicon.iconSrcForPackage(pkg, "grain", makeWildcardHost("static"));
      }
    } else if (!this._isUsingAnonymously()) {
      // Case 2
      const apiToken = this._db.collections.apiTokens.findOne({
        grainId: this._grainId,
        "owner.user.identityId": this.identityId(),
      }, {
        sort: { created: 1 },
      });

      if (apiToken) {
        const meta = apiToken.owner.user.denormalizedGrainMetadata;
        if (meta && meta.icon && meta.icon.assetId) return this._urlForAsset(meta.icon.assetId);
        if (meta && meta.appId) return Identicon.identiconForApp(meta.appId, "grain");
      }
    } else {
      // Case 3
      const tokenInfo = this._tokenInfo;
      if (tokenInfo && tokenInfo.grainMetadata) {
        const meta = tokenInfo.grainMetadata;
        if (meta.icon) return this._urlForAsset(meta.icon.assetId);
        if (meta.appId) return Identicon.identiconForApp(meta.appId, "grain");
      }
    }

    // jscs:disable disallowEmptyBlocks
    if (this._token) {
      // The TokenInfo collection includes some safe denormalized grain metadata.
    } else {
      //
    }
    // jscs:enable disallowEmptyBlocks

    // None of our other info sources were available.  Weird.  Show a fallback identicon.
    return this._fallbackIdenticon();
  }

  setFrameTitle(newFrameTitle) {
    this._frameTitle = newFrameTitle;
    this._dep.changed();
  }

  token() {
    this._dep.depend();
    return this._token;
  }

  generatedApiToken() {
    this._dep.depend();
    return this._generatedApiToken;
  }

  setGeneratedApiToken(newApiToken) {
    this._generatedApiToken = newApiToken;
    this._dep.changed();
  }

  setPowerboxRequest(powerboxRequest) {
    // If a previous powerboxRequest was set, clean it up before starting this new one.
    const previous = this._powerboxRequest.get();
    if (previous) previous.finalize();
    this._powerboxRequest.set(powerboxRequest);
  }

  showPowerboxRequest() {
    return !!this._powerboxRequest.get();
  }

  powerboxRequestData() {
    // The topbar template demands a ReactiveVar, so let it have a ReactiveVar :/
    return this._powerboxRequest;
  }

  showPowerboxOffer() {
    this._dep.depend();
    const session = Sessions.findOne({
      _id: this._sessionId,
    }, {
      fields: {
        powerboxView: 1,
      },
    });
    return !!(session && session.powerboxView && session.powerboxView.offer);
  }

  powerboxOfferData() {
    this._dep.depend();
    const sessionId = this._sessionId;
    const session = Sessions.findOne({
      _id: sessionId,
    }, {
      fields: {
        powerboxView: 1,
      },
    });

    const offer = session && session.powerboxView && session.powerboxView.offer;
    if (offer && offer.uiView) {
      // If this is an offer of a UiView, immediately dismiss the popup and open the grain.
      const apiToken = this._db.collections.apiTokens.findOne(offer.uiView.tokenId);
      if (apiToken && apiToken.grainId) {
        Meteor.call("finishPowerboxOffer", sessionId, function (err) {
          if (err) {
            console.error(err);
          }

          Router.go("grain", { grainId: apiToken.grainId });
        });
      }
    }

    return {
      get: function () {
        return {
          offer: offer,
          onDismiss: () => {
            Meteor.call("finishPowerboxOffer", sessionId, function (err) {
              // TODO(someday): display the error nicely to the user
              if (err) {
                console.error(err);
              }
            });
          },
        };
      },
    };
  }

  startPermissionsRequest(permissionName) {
    if (permissionType === "notifications") {
      const activeRequests = this._permissionRequests.get();
      activeRequests.push({ name: permissionName });
      this._permissionRequests.set(activeRequests);
    } else {
      console.error("Unknown permission type", permissionType);
    }
  }

  isPermissionRequestActive() {
    return this._permissionRequests.get().length !== 0;
  }

  hasPermission(permissionName) {
    // TODO: look in grain/apitoken
    return false;
  }

  grantedPermissions() {
    // TODO: actually pull this from the grain/apitoken the values are stored on
    return [];
  }
};

onceConditionIsTrue = (condition, continuation) => {
  Tracker.nonreactive(() => {
    Tracker.autorun((handle) => {
      if (!condition()) {
        return;
      }

      handle.stop();
      Tracker.nonreactive(continuation);
    });
  });
};
