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

// This file implements /grain, i.e. the main view into an app.

// Pseudo-collections.
TokenInfo = new Mongo.Collection("tokenInfo");
// TokenInfo is used by grainview.js
GrantedAccessRequests = new Mongo.Collection("grantedAccessRequests");
// Pseudo-collection about access requests
GrainLog = new Mongo.Collection("grainLog");
// Pseudo-collection created by subscribing to "grainLog", implemented in proxy.js.

const promptNewTitle = function () {
  const grain = globalGrains.getActive();
  if (grain) {
    let prompt = "Set new title:";
    if (!grain.isOwner()) {
      prompt = "Set a new personal title: (does not change the owner's title for this grain)";
    }

    const title = window.prompt(prompt, grain.title());
    if (title) {
      grain.setTitle(title);
    }
  }
};

const mapGrainStateToTemplateData = function (grainState) {
  const error = grainState.error();
  const templateData = {
    grainId: grainState.grainId(),
    active: grainState.isActive(),
    title: grainState.title(),
    error: error && error.message,
    unauthorized: error && (error.error == 403),
    notFound: error && (error.error == 404),
    appOrigin: grainState.origin(),
    hasNotLoaded: !(grainState.hasLoaded()),
    sessionId: grainState.sessionId(),
    originalPath: grainState._originalPath,
    interstitial: grainState.shouldShowInterstitial(),
    token: grainState.token(),
    viewInfo: grainState.viewInfo(),
    grainView: grainState,
  };
  return templateData;
};

Tracker.autorun(function () {
  // We need to keep track of certain data about each grain we can view.
  // TODO(cleanup): Do these in GrainView to avoid spurious resubscribes.
  const grains = globalGrains.getAll();
  grains.forEach(function (grain) {
    grain.depend();
    const grainId = grain.grainId();
    if (grainId) {
      Meteor.subscribe("grainTopBar", grainId);
      if (grain.isOwner()) {
        Meteor.subscribe("packageByGrainId", grainId);
      }

      const token = grain.token();
      if (token) {
        Meteor.subscribe("tokenInfo", token);
      }
    }
  });
});

Template.layout.events({
  "click .incognito-button": function (event) {
    console.log(event);
    const grains = globalGrains.getAll();
    const token = event.currentTarget.getAttribute("data-token");
    if (token) {
      grains.forEach(function (grain) {
        if (grain.token() == token) {
          grain.doNotRevealIdentity();
        }
      });
    } else {
      console.error("Interstitial prompt answered, but no token present?");
    }
  },
});

Template.grainTitle.events({
  click: function (event) {
    promptNewTitle();
  },

  keydown: function (event) {
    if ((event.keyCode === 13) || (event.keyCode === 32)) {
      // Allow space or enter to trigger renaming the grain - Firefox doesn't treat enter on the
      // focused element as click().
      promptNewTitle();
      event.preventDefault();
    }
  },
});

Template.grainDeleteButton.events({
  "click button": function (event) {
    const activeGrain = globalGrains.getActive();
    const grainId = activeGrain.grainId();
    if (activeGrain.isOwner()) {
      if (window.confirm("Really delete this grain?")) {
        Meteor.call("deleteGrain", grainId);
        globalGrains.remove(grainId, true);
      }
    } else {
      if (window.confirm("Really forget this grain?")) {
        const identityId = activeGrain.identityId();
        if (identityId) {
          Meteor.call("forgetGrain", grainId, identityId);
        }

        globalGrains.remove(grainId, true);
      }
    }
  },
});

Template.grainDebugLogButton.events({
  "click button": function (event) {
    this.reset();
    const activeGrain = globalGrains.getActive();
    window.open("/grainlog/" + activeGrain.grainId(), "_blank",
        "menubar=no,status=no,toolbar=no,width=700,height=700");
  },
});

Template.grainBackupButton.onCreated(function () {
  this.isLoading = new ReactiveVar(false);
});

Template.grainBackupButton.helpers({
  isLoading: function () {
    return Template.instance().isLoading.get();
  },
});

Template.grainBackupButton.events({
  "click button": function (event, template) {
    template.isLoading.set(true);
    this.reset();
    const activeGrain = globalGrains.getActive();
    Meteor.call("backupGrain", activeGrain.grainId(), function (err, id) {
      template.isLoading.set(false);
      if (err) {
        alert("Backup failed: " + err); // TODO(someday): make this better UI
      } else {
        // Firefox for some reason decides to kill all websockets when we try to download the file
        // by navigating there. So we're left doing a dirty hack to get around the popup blocker.
        const isFirefox = typeof InstallTrigger !== "undefined";

        if (isFirefox) {
          const save = document.createElement("a");
          save.href = "/downloadBackup/" + id;

          save.download = activeGrain.title() + ".zip";
          const event = document.createEvent("MouseEvents");
          event.initMouseEvent(
                  "click", true, false, window, 0, 0, 0, 0, 0,
                  false, false, false, false, 0, null
          );
          save.dispatchEvent(event);
        } else {
          window.location = "/downloadBackup/" + id;
        }
      }
    });
  },
});

Template.grainRestartButton.events({
  "click button": function (event) {
    this.reset();
    const activeGrain = globalGrains.getActive();
    const grainId = activeGrain.grainId();

    Meteor.call("shutdownGrain", grainId, function (err) {
      if (err) {
        alert("Restart failed: " + err); // TODO(someday): make this better UI
      } else {
        const frames = document.getElementsByClassName("grain-frame");
        for (let i = 0; i < frames.length; i++) {
          const frame = frames[i];
          if (frame.dataset.grainid == grainId) {
            frame.src = frame.src;
          }
        }
      }
    });
  },
});

function selectElementContents(element) {
  if (document.body.createTextRange) {
    const range = document.body.createTextRange();
    range.moveToElementText(element);
    range.select();
  } else if (window.getSelection) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
  }
}

function selectTargetContents(event) {
  event.preventDefault();
  selectElementContents(event.currentTarget);
}

Template.grainApiTokenPopup.events({
  "click .copy-me": selectTargetContents,
  "focus .copy-me": selectTargetContents,
  "submit .newApiToken": function (event) {
    event.preventDefault();
    const activeGrain = globalGrains.getActive();
    const grainId = activeGrain.grainId();
    activeGrain.setGeneratedApiToken("pending");
    const roleList = document.getElementById("api-token-role");
    // TODO(cleanup): avoid using global ids; select a child of the current template instead
    let assignment = { allAccess: null };
    if (roleList && roleList.selectedIndex > 0) {
      assignment = { roleId: roleList.selectedIndex - 1 };
    }

    Meteor.call("newApiToken", { identityId: activeGrain.identityId() }, grainId,
                document.getElementById("api-token-petname").value,
                assignment, { webkey: { forSharing: false } },
                function (error, result) {
      if (error) {
        activeGrain.setGeneratedApiToken(undefined);
        window.alert("Failed to create token.\n" + error);
        console.error(error.stack);
      } else {
        activeGrain.setGeneratedApiToken(
            window.location.protocol + "//" +
            globalDb.makeApiHost(result.token) + "#" + result.token);
      }
    });
  },

  "click #resetApiToken": function (event) {
    const activeGrain = globalGrains.getActive();
    activeGrain.setGeneratedApiToken(undefined);
  },

  "click button.revoke-token": function (event) {
    Meteor.call("updateApiToken", event.currentTarget.getAttribute("data-token-id"),
                { revoked: true });
  },

  "click .token-petname": function (event) {
    // TODO(soon): Find a less-annoying way to get this input, perhaps by allowing the user
    //   to edit the petname in place.
    const petname = window.prompt("Set new label:", this.petname);
    if (petname) {
      Meteor.call("updateApiToken", event.currentTarget.getAttribute("data-token-id"),
                  { petname: petname });
    }
  },
});

Template.grainSharePopup.events({
  "click .copy-me": selectTargetContents,
  "focus .copy-me": selectTargetContents,
  "click #share-grain-popup-closer": function (event) {
    Session.set("show-share-grain", false);
  },

  "click button.who-has-access": function (event, instance) {
    event.preventDefault();
    const closer = globalTopbar.addItem({
      name: "who-has-access",
      template: Template.whoHasAccess,
      popupTemplate: Template.whoHasAccessPopup,
      data: new ReactiveVar(instance.data),
      startOpen: true,
      onDismiss: function () {
        return "remove";
      },
    });
  },

  "click #privatize-grain": function (event) {
    Meteor.call("privatizeGrain", globalGrains.getActive().grainId());
  },

  "click a.open-non-anonymously": function (event) {
    event.preventDefault();
    globalTopbar.closePopup();
    globalGrains.getActive().reset();
    globalGrains.getActive().openSession();
  },
});

Template.shareWithOthers.onRendered(function () {
  this.find("[role=tab]").focus();
});

const activateTargetTab = function (event, instance) {
  // Deactivate all tabs and all tab panels.
  instance.findAll("ul[role=tablist]>li[role=tab]").forEach(function (element) {
    element.setAttribute("aria-selected", false);
  });

  instance.findAll(".tabpanel").forEach(function (element) {
    element.setAttribute("aria-hidden", true);
  });

  // Activate the tab header the user selected.
  event.currentTarget.setAttribute("aria-selected", true);
  // Show the corresponding tab panel.
  const idToShow = event.currentTarget.getAttribute("aria-controls");
  const tabPanelToShow = instance.find("#" + idToShow);
  tabPanelToShow.setAttribute("aria-hidden", false);
};

Template.shareWithOthers.events({
  "click #send-invite-tab-header": activateTargetTab,
  "click #shareable-link-tab-header": activateTargetTab,
  "keydown [role=tab]": function (event, template) {
    if (event.keyCode == 38 || event.keyCode == 40) { // up and down arrows
      event.preventDefault();
    }

    const $focus = $(template.find(":focus"));
    const $items = template.$("[role=tab]:visible");
    const focusIndex = $items.index($focus);
    let newFocusIndex;
    if (event.keyCode == 37) { // left arrow
      event.preventDefault();
      newFocusIndex = focusIndex - 1;
      if (newFocusIndex == -1) {
        newFocusIndex = $items.length - 1;
      }
    } else if (event.keyCode == 39) { // right arrow
      event.preventDefault();
      newFocusIndex = focusIndex + 1;
      if (newFocusIndex >= $items.length) {
        newFocusIndex = 0;
      }
    } else if (event.keyCode == 13) { // Enter key
      event.preventDefault();
      activateTargetTab(event, template);
    }

    if (newFocusIndex != null) {
      $items.attr("tabindex", "-1");
      const $newFocus = $($items[newFocusIndex]);
      $newFocus.attr("tabindex", "0");
      $newFocus.focus();
    }
  },
});

Template.shareableLinkTab.events({
  "change .share-token-role": function (event, instance) {
    const success = instance.completionState.get().success;
    if (success) {
      const roleList = event.target;
      let assignment;
      if (roleList) {
        assignment = { roleId: roleList.selectedIndex };
      } else {
        assignment = { none: null };
      }

      Meteor.call("updateApiToken", success.id, { roleAssignment: assignment }, function (error) {
        if (error) {
          console.error(error.stack);
        }
      });
    }
  },

  "change .label": function (event, instance) {
    const success = instance.completionState.get().success;
    if (success) {
      const label = event.target.value;
      Meteor.call("updateApiToken", success.id, { petname: label }, function (error) {
        if (error) {
          console.error(error.stack);
        }
      });
    }
  },

  "submit form.new-share-token": function (event, instance) {
    event.preventDefault();
    if (!instance.completionState.get().clear) {
      return;
    }

    const currentGrain = globalGrains.getActive();
    const grainId = currentGrain.grainId();
    const roleList = event.target.getElementsByClassName("share-token-role")[0];
    let assignment;
    if (roleList) {
      assignment = { roleId: roleList.selectedIndex };
    } else {
      assignment = { none: null };
    }

    instance.completionState.set({ pending: true });
    Meteor.call("newApiToken", { identityId: currentGrain.identityId() }, grainId,
                event.target.getElementsByClassName("label")[0].value,
                assignment, { webkey: { forSharing: true } },
                function (error, result) {
      if (error) {
        console.error(error.stack);
      } else {
        result.url = getOrigin() + "/shared/" + result.token;
        instance.completionState.set({ success: result });
        // On the next render, .copy-me will exist, and we should focus it then.
        Meteor.defer(function () {
          const element = instance.find(".copy-me");
          element.focus();
          selectElementContents(element);
        });
      }
    });
  },

  "click .reset-share-token": function (event, instance) {
    instance.completionState.set({ clear: true });
    instance.find("form").reset();
    instance.find("form option[data-default-selected=true]").selected = true;
  },
});

Template.grainPowerboxOfferPopup.events({
  "click button.dismiss": function (event) {
    const data = Template.instance().data.get();
    data.onDismiss();
  },

  "click .copy-me": selectTargetContents,
  "focus .copy-me": selectTargetContents,
});

Template.grainSharePopup.helpers({
  incognito: function () {
    return !Accounts.getCurrentIdentityId();
  },

  currentTokenUrl: function () {
    let token = globalGrains.getActive().token();
    if (token) {
      return getOrigin() + "/shared/" + token;
    }
  },

  currentGrain: function () {
    return globalGrains.getActive();
  },
});

Template.wrongIdentity.helpers({
  unclickedMessage: function () {
    if (Meteor.userId()) {
      return "Click to sign out of your current session and sign in as the above identity.";
    } else {
      return "Click to sign in.";
    }
  },
});

Template.requestAccess.onCreated(function () {
  this._status = new ReactiveVar({ showButton: true });
  this._grain = this.data.grainView;

  this.autorun(() => {
    Meteor.userId(); // Read this value so that we resubscribe on login.
    const grainId = this._grain.grainId();
    this.subscribe("requestingAccess", grainId);
    const granted = GrantedAccessRequests.findOne({ grainId: grainId });
    if (granted && !this._grain.token()) {
      this._grain.reset(granted.identityId);
      this._grain.openSession();
    }
  });
});

Template.requestAccess.events({
  "click button.request-access": function (event, instance) {
    instance._status.set({ chooseIdentity: true });
  },
});

Template.requestAccess.helpers({
  status: function () {
    return Template.instance()._status.get();
  },

  chooseIdentityText: function () {
    if (SandstormDb.getUserIdentityIds(Meteor.user()).length > 1) {
      return "Please select an identity with which to request access.";
    } else {
      return "To confirm, please click on your identity below.";
    }
  },

  identityPickerData: function () {
    const identities = SandstormDb.getUserIdentityIds(Meteor.user())
          .map(id => globalDb.getIdentity(id));
    const instance = Template.instance();
    function onPicked(identityId) {
      let grainId = instance._grain.grainId();
      Meteor.call("requestAccess", getOrigin(), grainId, identityId, function (error, result) {
        if (error) {
          instance._status.set({ error: error });
        } else {
          instance._status.set({ success: true });
        }
      });

      instance._status.set({ waiting: true });
    }

    return {
      identities: identities,
      onPicked: onPicked,
    };
  },
});

Template.grainView.helpers({
  unpackedGrainState: function () {
    return mapGrainStateToTemplateData(this);
  },

  identityPickerData: function () {
    const identities = SandstormDb.getUserIdentityIds(Meteor.user()).map(function (id) {
      const identity = Meteor.users.findOne({ _id: id });
      if (identity) {
        SandstormDb.fillInProfileDefaults(identity);
        SandstormDb.fillInIntrinsicName(identity);
        SandstormDb.fillInPictureUrl(identity);
        return identity;
      }
    });

    const grain = globalGrains.getActive();
    return { identities: identities,
            onPicked: function (identityId) { grain.revealIdentity(identityId); }, };
  },
});

Template.grain.helpers({
  currentGrain: function () {
    return globalGrains.getActive();
  },

  hasAccess: function () {
    const grain = globalGrains.getActive();
    return grain && !!Sessions.findOne(grain.sessionId());
  },

  isOwner: function () {
    const current = globalGrains.getActive();
    return current && current.isOwner();
  },

  grainSize: function () {
    const current = globalGrains.getActive();
    const sizeBytes = current && current.size();
    if (sizeBytes !== undefined) {
      return "(" + prettySize(sizeBytes) + ")";
    } else {
      return "";
    }
  },

  setGrainWindowTitle:  function () {
    const current = globalGrains.getActive();
    if (current) {
      current.updateDocumentTitle();
    }
  },

  displayWebkeyButton: function () {
    const grain = globalGrains.getActive();
    return Meteor.userId() || (grain && !grain.isOldSharingModel());
  },

  showPowerboxOffer: function () {
    const current = globalGrains.getActive();
    return current && current.showPowerboxOffer();
  },

  powerboxOfferData: function () {
    const current = globalGrains.getActive();
    return current && current.powerboxOfferData();
  },

  showPowerboxRequest: function () {
    const current = globalGrains.getActive();
    return current && current.showPowerboxRequest();
  },

  powerboxRequestData: function () {
    const current = globalGrains.getActive();
    return current && current.powerboxRequestData();
  },

  cancelPowerboxRequest: function () {
    return () => {
      const current = globalGrains.getActive();
      current.setPowerboxRequest(undefined);
      return "remove";
    };
  },
});

Template.grainTitle.helpers({
  fullTitle: function () {
    const grain = globalGrains.getActive();
    return (grain && grain.fullTitle()) || { title: "(unknown grain)" };
  },

  hasSubtitle: function () {
    return !!(this.was || this.renamedFrom);
  },
});

Template.grainApiTokenPopup.helpers({
  displayToken: function () {
    return !this.revoked && !this.expiresIfUnused && !this.parentToken;
  },

  existingTokens: function () {
    const current = globalGrains.getActive();
    return current && ApiTokens.find({
      grainId: current.grainId(),
      identityId: current.identityId(),
      forSharing: { $ne: true },
      $or: [
        { owner: { webkey: null } },
        { owner: { $exists: false } },
      ],
      expiresIfUnused: null,
    });
  },

  generatedApiToken: function () {
    const current = globalGrains.getActive();
    return current && current.generatedApiToken();
  },

  generatedApiTokenPending: function () {
    const current = globalGrains.getActive();
    return (current && current.generatedApiToken()) == "pending";
  },

  viewInfo: function () {
    const current = globalGrains.getActive();
    return current && current.viewInfo();
  },
});

Template.whoHasAccessPopup.onCreated(function () {
  const _this = this;
  this.subscribe("contactProfiles", true);
  const currentGrain = globalGrains.getActive();
  _this.identityId = currentGrain.identityId();
  _this.grainId = currentGrain.grainId();
  _this.transitiveShares = new ReactiveVar(null);
  _this.downstreamTokensById = new ReactiveVar({});
  this.resetTransitiveShares = function () {
    Meteor.call("transitiveShares", _this.identityId, _this.grainId,
                function (error, downstream) {
      if (error) {
        console.error(error.stack);
      } else {
        const downstreamTokensById = {};
        const sharesByRecipient = {};
        downstream.forEach(function (token) {
          downstreamTokensById[token._id] = token;
          if (Match.test(token.owner, { user: Match.ObjectIncluding({ identityId: String }) })) {
            const recipient = token.owner.user.identityId;
            if (!sharesByRecipient[recipient]) {
              sharesByRecipient[recipient] = {
                recipient: recipient,
                dedupedShares: [],
                allShares: [],
              };
            }

            sharesByRecipient[recipient].allShares.push(token);
            const dedupedShares = sharesByRecipient[recipient].dedupedShares;
            if (!dedupedShares.some((share) => share.identityId === token.identityId)) {
              dedupedShares.push(token);
            }
          }
        });

        let result = _.values(sharesByRecipient);
        if (result.length == 0) {
          result = { empty: true };
        }

        _this.transitiveShares.set(result);
        _this.downstreamTokensById.set(downstreamTokensById);
      }
    });
  };

  this.resetTransitiveShares();
});

Template.whoHasAccessPopup.events({
  "change .share-token-role": function (event, instance) {
    const roleList = event.target;
    let assignment;
    if (roleList) {
      assignment = { roleId: roleList.selectedIndex };
    } else {
      assignment = { none: null };
    }

    Meteor.call("updateApiToken", roleList.getAttribute("data-token-id"),
                { roleAssignment: assignment }, function (error) {
      if (error) {
        console.error(error.stack);
      }
    });
  },

  "click button.revoke-token": function (event, instance) {
    Meteor.call("updateApiToken", event.currentTarget.getAttribute("data-token-id"),
                { revoked: true });
    instance.resetTransitiveShares();
  },

  "click button.revoke-access": function (event, instance) {
    const recipient = event.currentTarget.getAttribute("data-recipient");
    const transitiveShares = instance.transitiveShares.get();
    const tokensById = instance.downstreamTokensById.get();
    const recipientShares = _.findWhere(transitiveShares, { recipient: recipient });
    const currentIdentityId = Accounts.getCurrentIdentityId();
    const recipientTokens = _.where(recipientShares.allShares, { identityId: currentIdentityId });

    // Two cases:
    // 1. All of the tokens are direct shares. Easy. Just revoke them.
    // 2. Some of the links are child tokens. For each, we walk up the chain of parents to the
    //    root. Then we walk downwards to see whether any other identities would be immediately
    //    affected by revoking those roots. We then collect that data and display it in a
    //    confirmation dialog.

    let directTokens = [];
    // Direct shares from the current identity to the recipient.

    let rootTokens = [];
    // Roots of chains of child tokens starting at the current identity and leading to the
    // recipient.

    recipientTokens.forEach((token) => {
      if (token.parentToken) {
        let currentToken = token;
        do {
          currentToken = tokensById[token.parentToken];
        } while (currentToken.parentToken);

        rootTokens.push(currentToken);
      } else {
        directTokens.push(token);
      }
    });

    if (rootTokens.length > 0) {
      // Some of the shares are not direct.

      let tokensByParent = {};
      for (let id in tokensById) {
        let token = tokensById[id];
        if (token.parentToken) {
          if (!tokensByParent[token.parentToken]) {
            tokensByParent[token.parentToken] = [];
          }

          tokensByParent[token.parentToken].push(token);
        }
      }

      let otherAffectedIdentities = {};
      let tokenStack = rootTokens.slice(0);
      while (tokenStack.length > 0) {
        let current = tokenStack.pop();
        if (Match.test(current.owner,
                       { user: Match.ObjectIncluding({ identityId: String }) })) {
          if (current.owner.user.identityId != recipient) {
            otherAffectedIdentities[current.owner.user.identityId] = true;
          }
        } else {
          if (tokensByParent[current._id]) {
            let children = tokensByParent[current._id];
            children.forEach(child => {
              tokenStack.push(child);
            });
          }
        }
      }

      const recipientIdentity = ContactProfiles.findOne({ _id: recipient });
      const recipientName = (recipientIdentity && recipientIdentity.profile.name) ||
          "Unknown User";
      const singular = rootTokens.length == 1;

      const tokenLabels = _.pluck(rootTokens, "petname")
          .map(petname => petname || "Unlabeled Link")
          .map(petname => "\"" + petname + "\"")
          .join(", ");

      let confirmText = "This will revoke the following sharing link" + (singular ? "" : "s") +
          ":\n\n    " + tokenLabels + "\n\n";

      let othersNote = "(No signed-in user other than " + recipientName + " has opened " +
          (singular ? "this link" : "these links") + " yet.)";
      if (Object.keys(otherAffectedIdentities).length > 0) {
        const othersNames = Object.keys(otherAffectedIdentities)
            .map(identityId => ContactProfiles.findOne({ _id: identityId }))
            .map(identity => (identity && identity.profile.name) || "Unknown User")
            .join(", ");
        othersNote = (singular ? "This link has" : "These links have") +
          " also been opened by:\n\n    " + othersNames;
      }

      if (window.confirm(confirmText + othersNote)) {
        rootTokens.forEach((token) => {
          Meteor.call("updateApiToken", token._id, { revoked: true });
        });
      } else {
        // Cancel.
        return;
      }
    }

    directTokens.forEach((token) => {
      Meteor.call("updateApiToken", token._id, { revoked: true });
    });

    instance.resetTransitiveShares();
  },

  "click .token-petname": function (event, instance) {
    // TODO(soon): Find a less-annoying way to get this input, perhaps by allowing the user
    //   to edit the petname in place.
    const petname = window.prompt("Set new label:", this.petname);
    if (petname) {
      Meteor.call("updateApiToken", event.currentTarget.getAttribute("data-token-id"),
                  { petname: petname });
    }

    instance.resetTransitiveShares();
  },
});

function isEmptyPermissionSet(permissionSet) {
  if (!permissionSet) {
    return true;
  }

  for (let ii = 0; ii < permissionSet.length; ++ii) {
    if (permissionSet[ii]) {
      return false;
    }
  }

  return true;
}

Template.whoHasAccessPopup.helpers({
  existingShareTokens: function () {
    if (Meteor.userId()) {
      return ApiTokens.find({
        grainId: Template.instance().grainId,
        identityId: Template.instance().identityId,
        forSharing: true,
        $or: [
          { owner: { webkey:null } },
          { owner: { $exists: false } },
        ],
      }).fetch();
    }
  },

  isCurrentIdentity: function () {
    if (this.identityId === Accounts.getCurrentIdentityId()) {
      return true;
    }
  },

  getPetname: function () {
    if (this.petname) {
      return this.petname;
    } else {
      return "Unlabeled Link";
    }
  },

  displayName: function (identityId) {
    let identity = ContactProfiles.findOne({ _id: identityId });
    if (!identity) {
      identity = Meteor.users.findOne({ _id: identityId });
      SandstormDb.fillInProfileDefaults(identity);
    }

    if (identity) {
      return identity.profile.name;
    } else {
      return "Unknown User (" + identityId.slice(0, 16) + ")";
    }
  },

  transitiveShares: function () {
    return Template.instance().transitiveShares.get();
  },

  indexedRoles: function () {
    const result = [];
    const instance = Template.instance();
    const currentGrain = globalGrains.getActive();
    const roles = currentGrain.viewInfo().roles;
    for (let ii = 0; ii < roles.length; ++ii) {
      result.push({ idx: ii, title: roles[ii].title, verbPhrase: roles[ii].verbPhrase });
    }

    return result;
  },

  roleText: function () {
    if (this.verbPhrase) {
      return this.verbPhrase.defaultText;
    } else {
      return "is " + this.title.defaultText;
    }
  },

  hasCustomRole: function (token) {
    const role = token.roleAssignment;
    if ("roleId" in role &&
        isEmptyPermissionSet(role.addPermissions) &&
        isEmptyPermissionSet(role.removePermissions)) {
      return false;
    }

    return true;
  },

  hasCurrentRole: function (token) {
    const role = token.roleAssignment;
    if ("roleId" in role && role.roleId == this.idx &&
        isEmptyPermissionSet(role.addPermissions) &&
        isEmptyPermissionSet(role.removePermissions)) {
      return true;
    }

    return false;
  },

  displayToken: function () {
    return !this.revoked && !this.expiresIfUnused && !this.parentToken;
  },

  viewInfo: function () {
    const activeGrain = globalGrains.getActive();
    return activeGrain && activeGrain.viewInfo();
  },
});

Template.selectRole.helpers({
  roleText: function () {
    if (this.verbPhrase) {
      return this.verbPhrase.defaultText;
    } else {
      return "is " + this.title.defaultText;
    }
  },
});

Template.shareableLinkTab.onCreated(function () {
  this.completionState = new ReactiveVar({ clear: true });
});

Template.emailInviteTab.onCreated(function () {
  this.completionState = new ReactiveVar({ clear: true });
  this.contacts = new ReactiveVar([]);
  this.grain = globalGrains.getActive();
});

Template.emailInviteTab.onDestroyed(function () {
  Session.set("share-grain-" + Template.instance().grain.grainId(), undefined);
});

Template.shareableLinkTab.helpers({
  completionState: function () {
    const instance = Template.instance();
    return instance.completionState.get();
  },
});
Template.emailInviteTab.helpers({
  completionState: function () {
    const instance = Template.instance();
    return instance.completionState.get();
  },

  contacts: function () {
    return Template.instance().contacts;
  },

  preselectedIdentityId: function () {
    return Session.get("share-grain-" + Template.instance().grain.grainId());
  },

  invitationExplanation: function () {
    const primaryEmail = globalDb.getPrimaryEmail(Meteor.userId(), Accounts.getCurrentIdentityId());
    if (primaryEmail) {
      return "Invitation will be from " + primaryEmail;
    } else {
      return null;
    }
  },
});

Template.emailInviteTab.events({
  "submit form.email-invite": function (event, instance) {
    event.preventDefault();
    return false;
  },

  "click form.email-invite button": function (event, instance) {
    event.preventDefault();
    if (!instance.completionState.get().clear) {
      return;
    }

    const grainId = instance.data.grainId;
    const title = instance.data.title;

    const roleList = instance.find(".share-token-role");
    let assignment;
    if (roleList) {
      assignment = { roleId: roleList.selectedIndex };
    } else {
      assignment = { none: null };
    }

    const message = instance.find(".personal-message").value;
    instance.completionState.set({ pending: true });

    const currentGrain = globalGrains.getActive();

    // HTML-escape the message.
    const div = document.createElement("div");
    div.appendChild(document.createTextNode(message));
    const htmlMessage = div.innerHTML.replace(/\n/g, "<br>");

    const contacts = instance.contacts.get();
    const emails = instance.find("input.emails");
    const emailsValue = emails.value;
    if (emailsValue) {
      if (emailsValue.match(/.+\@.+\..+/)) {
        contacts.push({
          _id: emailsValue,
          profile: {
            service: "email",
            name: emailsValue,
            intrinsicName: emailsValue,
            pictureUrl: "/email.svg",
          },
          isDefault: true,
        });
        instance.contacts.set(contacts);
        emails.value = "";
      } else {
        instance.completionState.set(
          { error: "Unknown user \"" + emailsValue + "\". Try entering an e-mail address." });
        return;
      }
    }

    Meteor.call("inviteUsersToGrain", getOrigin(), currentGrain.identityId(),
                grainId, title, assignment, contacts,
                { text: message, html: htmlMessage }, function (error, result) {
      if (error) {
        instance.completionState.set({ error: error.toString() });
      } else {
        if (result.failures.length > 0) {
          let message = "Failed to send to: ";
          for (let ii = 0; ii < result.failures.length; ++ii) {
            console.error(result.failures[ii].error);
            if (ii != 0) {
              message += ", ";
            }

            message += result.failures[ii].contact.profile.name;
            const warning = result.failures[ii].warning;
            if (warning) {
              message += ". " + warning;
            }
          }

          instance.completionState.set({ error: message });
        } else {
          instance.completionState.set({ success: "success" });
        }
      }
    });
  },

  "click .reset-invite": function (event, instance) {
    instance.contacts.set([]);
    instance.completionState.set({ clear: true });
    instance.find("form").reset();
    instance.find("form option[data-default-selected=true]").selected = true;
  },

  "click .start-over-invite": function (event, instance) {
    instance.completionState.set({ clear: true });
  },
});

Template.grainPowerboxOfferPopup.helpers({
  powerboxOfferUrl: function () {
    const offer = Template.instance().data.get().offer;
    return offer && offer.url;
  },
});

// Send a keep-alive for each grain every now and then.
Meteor.setInterval(function () {
  const grains = globalGrains.getAll();
  if (!grains) return;

  // Meteor has an exponential backoff of up to 5 minutes for reconnect. This is unnacceptable
  // for us, since we rely on Sessions being re-established in under 60s.
  if (Meteor.status().status === "waiting") {
    console.log("Sandstorm is trying to reconnect...");
    Meteor.reconnect();
  }

  grains.forEach(function (grain) {
    if (grain.sessionId()) {
      // TODO(soon):  Investigate what happens in background tabs.  Maybe arrange to re-open the
      //   app if it dies while in the background.
      Meteor.call("keepSessionAlive", grain.sessionId(), function (error, result) {
        // Sessions will automatically resume if possible, otherwise they will refresh.
      });
    }
  });
}, 60000);

const memoizedNewApiToken = {};
// Maps sha256(JSON.stringify(parameters)) -> {timestamp, promise}
//
// This memoizes calls to the Meteor method "newApiToken", so that multiple calls in rapid
// succession will not create multiple tokens. `parameters` above is an array containing the
// calls parameters in order (excluding the method name and callback), and `promise` is a promise
// for the result of the call.

// Message handler for Sandstorm's client-side postMessage API.
Meteor.startup(function () {
  const messageListener = function (event) {
    if (event.origin === getOrigin()) {
      // Meteor likes to postMessage() to itself sometimes, so we ignore these messages.
      return;
    }

    // Look up the grain that this postmessage came from, so we can map behavior into that
    // particular grain's state
    const senderGrain = globalGrains.getByOrigin(event.origin);
    if (!senderGrain) {
      // We got a postMessage from an origin that is not a grain we currently believe is open.
      // Ignore it. (It may be aimed at some other message listener registered elsewhere...)
      return;
    }

    if (event.data.setPath || event.data.setPath === "") {
      const path = event.data.setPath || "/";
      check(path, String);
      check(path.charAt(0), "/");
      // TODO(security): More sanitization of this path. E.g. reject "/../../".
      senderGrain.setPath(path);
    } else if (event.data.startSharing) {
      // Allow the current grain to request that the "Share Access" menu be shown.
      // Only show this popup if no other popup is currently active.
      // TODO(security): defend against malicious apps spamming this call, blocking all other UI.
      const currentGrain = globalGrains.getActive();
      if (senderGrain === currentGrain && !globalTopbar.isPopupOpen()) {
        globalTopbar.openPopup("share");
      }
    } else if (event.data.setTitle || event.data.setTitle === "") {
      senderGrain.setFrameTitle(event.data.setTitle);
    } else if (event.data.renderTemplate) {
      // Request creation of a single-use template with a privileged API token.
      // Why?  Apps should not be able to obtain capabilities-as-keys to
      // themselves directly, because those can be leaked through an
      // arbitrary bit stream or covert channel.  However, apps often need a
      // way to provide instructions to users to copy/paste with some
      // privileged token contained within.  By providing this templating in
      // the platform, we can ensure that the token is only visible to the
      // shell's origin.
      const call = event.data.renderTemplate;
      check(call, Object);
      const rpcId = call.rpcId;
      try {
        check(call, {
          rpcId: String,
          template: String,
          petname: Match.Optional(String),
          roleAssignment: Match.Optional(roleAssignmentPattern),
          forSharing: Match.Optional(Boolean),
          clipboardButton: Match.Optional(Match.OneOf(undefined, null, "left", "right")),
          unauthenticated: Match.Optional(Object),
          // Note: `unauthenticated` will be validated on the server. We just pass it through
          //   here.
        });
      } catch (error) {
        event.source.postMessage({ rpcId: rpcId, error: error.toString() }, event.origin);
        return;
      }

      const template = call.template;
      let petname = "connected external app";
      if (call.petname) {
        petname = call.petname;
      }

      let assignment = { allAccess: null };
      const clipboardButton = call.clipboardButton;
      if (call.roleAssignment) {
        assignment = call.roleAssignment;
      }

      const forSharing = call.forSharing ? call.forSharing : false;
      // Tokens expire by default in 5 minutes from generation date
      const selfDestructDuration = 5 * 60 * 1000;

      let provider;
      if (Router.current().route.getName() === "shared") {
        provider = { rawParentToken: Router.current().params.token };
      } else {
        provider = { identityId: senderGrain.identityId() };
      }

      const owner = {
        webkey: {
          forSharing: forSharing,
          expiresIfUnusedDuration: selfDestructDuration,
        },
      };

      const params = [
        provider, senderGrain.grainId(), petname, assignment, owner, call.unauthenticated,
      ];

      const memoizeKey = SHA256(JSON.stringify(params));
      let memoizeResult = memoizedNewApiToken[memoizeKey];
      if (memoizeResult && (Date.now() - memoizeResult.timestamp > selfDestructDuration / 2)) {
        // Memoized result is too old. Discard.
        memoizeResult = undefined;
      }

      if (!memoizeResult) {
        memoizedNewApiToken[memoizeKey] = memoizeResult = {
          timestamp: Date.now(),
          promise: new Promise(function (resolve, reject) {
            const callback = (err, result) => {
              if (err) {
                reject(err);
              } else {
                resolve(result);
              }
            };

            Meteor.call.apply(Meteor, ["newApiToken"].concat(params, callback));
          }),
        };
      }

      memoizeResult.promise.then((result) => {
        const tokenId = result.token;
        // Generate random key id2.
        const id2 = Random.secret();
        // Store apitoken id1 and template in session storage in the offer
        // template namespace under key id2.
        const key = "offerTemplate" + id2;
        const host = globalDb.makeApiHost(tokenId);
        const grain = senderGrain;
        const grainTitle = grain.title();
        // grainTitleSlug is the grain title with url-unsafe characters replaced
        let grainTitleSlug = grainTitle.toLowerCase().trim();
        grainTitleSlug = grainTitleSlug.replace(/\s+/g, "-")
                                       .replace(/[^\w\-]+/g, "")
                                       .replace(/\-\-+/g, "-")
                                       .replace(/^-+/, "")
                                       .replace(/-+$/, "");
        const renderedTemplate = template.replace(/\$API_TOKEN/g, tokenId)
                                         .replace(/\$API_HOST/g, host)
                                         .replace(/\$GRAIN_TITLE_SLUG/g, grainTitleSlug);
        sessionStorage.setItem(key, JSON.stringify({
            token: tokenId,
            renderedTemplate: renderedTemplate,
            clipboardButton: clipboardButton,
            expires: Date.now() + selfDestructDuration,
            host,
          })
        );

        // Send message to event.source with URL containing id2
        // TODO(someday): Send back the tabId that requests to this token will use? Could be
        //   useful.
        templateLink = window.location.origin + "/offer-template.html#" + id2;
        event.source.postMessage({ rpcId: rpcId, uri: templateLink }, event.origin);
      }, (error) => {
        event.source.postMessage({ rpcId: rpcId, error: error.toString() }, event.origin);
      });
    } else if (event.data.powerboxRequest) {
      const powerboxRequest = event.data.powerboxRequest;
      check(powerboxRequest, {
        // TODO: be more strict, and check more fields, once the test apps are more conformant
        rpcId: Match.Any,
        query: Match.Optional([String]),
        saveLabel: Match.Optional(Match.ObjectIncluding({ defaultText: String })),
      });

      const powerboxRequestInfo = {
        source: event.source,
        origin: event.origin,
        // We'll need these to post a reply message

        rpcId: powerboxRequest.rpcId,
        query: powerboxRequest.query,
        saveLabel: powerboxRequest.saveLabel,
        // These data come from the grain

        sessionId: senderGrain.sessionId(),
        grainId: senderGrain.grainId(),
        identityId: senderGrain.identityId(),
        // Attach grain context to the request.

        onCompleted: function () { globalTopbar.closePopup(); },
        // Allow the grain to close the popup when we've completed the request.
      };
      const requestContext = new SandstormPowerboxRequest(globalDb, powerboxRequestInfo);
      senderGrain.setPowerboxRequest(requestContext);
      globalTopbar.openPopup("request");
    } else if (event.data.notificationRefreshPermission) {
      // TODO: attenuate this by whether or not this grain has permission from the shell to show
      // notifications yet or not
      const resp = { notificationPermissionChanged: { newValue: Notification.permission } };
      event.source.postMessage(resp, event.origin);
    } else if (event.data.notificationRequestPermission) {
      // TODO: check against DB if this grain is permitted to show things and if we have
      // browser permission.  If so, shortcircuit around Notification.requestPermission.
      Notification.requestPermission(function (perm) {
        const resp = { notificationPermissionChanged: { newValue: Notification.permission } };
        event.source.postMessage(resp, event.origin);
      });
    } else if (event.data.notificationCreate) {
      const req = event.data.notificationCreate;
      const notificationId = req.notificationId;
      // Sanitize req.notificationArgs, as described in
      // https://github.com/sandstorm-io/sandstorm/issues/919
      // We need to verify any argument that could be a URI refers only to the grain's origin or
      // the shell's origin.  We also don't want to pass on any options that aren't defined in the
      // Notification spec.
      const requestedOptions = req.notificationArgs.options || {};
      const passthroughKeys = [
        "dir", "lang", "body", "data", // Defined and implemented in current browsers
        "vibrate", "renotify", "silent", "noscreen", "sticky", // Defined in specs
      ];
      const sanitizeKeys = ["icon", "sound"];
      const sanitizeUri = function (uri) {
        if (uri === undefined || uri === null) return uri;
        // Check that scheme/host/port matches, and that the next character is a / (indicating
        // start of the path).
        const origin = senderGrain.origin();
        if (uri.indexOf(origin, 0) === 0 && uri[origin.length] === "/") {
          // Absolute URL matching the grain's origin.  Safe to pass through as-is.
          return uri;
        }

        if (uri[0] === "/" && uri[1] !== "/") {
          // Absolute path, no scheme/host/port.  Return the path given with grain
          // origin prepended.
          return origin + uri;
        }

        // TODO(someday): consider allowing protocol-relative URIs, or relative paths?
        // Check what browser behavior is.  Relative paths may require setPath() integration to
        // behave correctly, but I'm willing to bet that very few applications will need this.
        console.warn("Blocked use of " + uri + " by grain " + senderGrain.grainId() + " \"" + senderGrain.title() + "\"");
        console.log("Notifications may only use icons or sound files from their own origin, e.g. " + senderGrain.origin());
        return undefined;
      };

      const sanitizedOptions = {};
      for (let i = 0; i < passthroughKeys.length; i++) {
        const key = passthroughKeys[i];
        sanitizedOptions[key] = requestedOptions[key];
      }

      for (let i = 0; i < sanitizeKeys.length; i++) {
        const key = sanitizeKeys[i];
        sanitizedOptions[key] = sanitizeUri(requestedOptions[key]);
      }
      // Prefix the tag field with the grain ID, so apps can't interfere with each other's
      // notifications, but can still replace their own notifications.
      sanitizedOptions.tag = requestedOptions.tag ?
          senderGrain.grainId() + "-" + requestedOptions.tag :
          requestedOptions.tag;
      const notification = new Notification(req.notificationArgs.title, sanitizedOptions);

      // set up onclick and onerror to trigger postMessage replies
      notification.onclick = function (clickEvent) {
        // Request that the Sandstorm window receive focus.  This attempts to switch the browser's
        // active tab and window to the Sandstorm window that requested the notification.
        window.focus();
        // Then, with this tab focused, activate the grain that created the notification that the
        // user clicked.
        Router.go(senderGrain.route());
        const resp = { notificationClicked: { notificationId } };
        event.source.postMessage(resp, event.origin);
      };

      notification.onerror = function (errorEvent) {
        const resp = { notificationError: { notificationId } };
        event.source.postMessage(resp, event.origin);
      };

      // I'm just attaching a field to the GrainView instance here - perhaps it should get public API in grainview.js?
      senderGrain.notifications = senderGrain.notifications || {};
      senderGrain.notifications[notificationId] = notification;
      // No immediate reply needed.
    } else if (event.data.notificationClose) {
      const req = event.data.notificationClose;
      const notification = senderGrain.notifications && senderGrain.notifications[req.notificationId];
      notification && notification.close();
      // No reply needed.
    } else {
      console.log("postMessage from app not understood: ", event.data);
      console.log(event);
    }
  };

  window.addEventListener("message", messageListener, false);
});

const scrollLogToBottom = function (elem) {
  elem.scrollTop = elem.scrollHeight;
};

const maybeScrollLog = function () {
  const elem = document.getElementById("grainLog");
  if (elem) {
    // The log already exists. It's about to be updated. Check if it's scrolled to the bottom
    // before the update.
    if (elem.scrollHeight - elem.scrollTop === elem.clientHeight) {
      // Indeed, so we want to scroll it back to the bottom after the update.
      Tracker.afterFlush(function () { scrollLogToBottom(elem); });
    }
  } else {
    // No element exists yet, but it's probably about to be created, in which case we definitely
    // want to scroll it.
    Tracker.afterFlush(function () {
      const elem2 = document.getElementById("grainLog");
      if (elem2) scrollLogToBottom(elem2);
    });
  }
};

Router.map(function () {
  this.route("apps", {
    path: "/apps",
    waitOn: function () { return globalSubs; },

    data: function () {
      if (!this.ready()) return;
      if (!Meteor.userId() && !Meteor.loggingIn()) {
        Router.go("root", {}, { replaceState: true });
      }

      return new SandstormAppList(globalDb, globalQuotaEnforcer);
    },
  });
  this.route("newGrainRedirect", {
    // The path /grain/new used to be where you would go to create new grains.
    // Its functionality has been superceded by the apps route, so redirect in
    // case anyone has the old link saved somewhere.
    path: "/grain/new",
    onBeforeAction: function () {
      Router.go("apps", {}, { replaceState: true });
    },
  });
  this.route("grains", {
    path: "/grain",
    waitOn: function () { return globalSubs; },

    data: function () {
      if (!this.ready()) return;
      if (!Meteor.userId() && !Meteor.loggingIn()) {
        Router.go("root", {}, { replaceState: true });
      }

      return new SandstormGrainListPage(globalDb, globalQuotaEnforcer);
    },
  });
  this.route("grain", {
    path: "/grain/:grainId/:path(.*)?",
    loadingTemplate: "loadingNoMessage",

    waitOn: function () {
      return globalSubs;
    },

    onBeforeAction: function () {
      // Only run the hook once.
      if (this.state.get("beforeActionHookRan")) return this.next();

      Tracker.nonreactive(() => {
        this.state.set("beforeActionHookRan", true);
        const grainId = this.params.grainId;

        let initialPopup = null;
        let shareGrain = Session.get("share-grain-" + grainId);
        if (shareGrain) {
          initialPopup = "share";
        }

        const path = "/" + (this.params.path || "") + (this.originalUrl.match(/[#?].*$/) || "");

        // The element we need to attach our Blaze view to may not exist yet.
        // In that case, defer creating the GrainView until we're sure it's
        // had a chance to render.
        const openView = function openView() {
          // If the grain is already open in a tab, switch to that tab. We have to re-check this
          // every time we defer to avoid race conditions (especially at startup, with the
          // restore-last-opened code).
          let grain = globalGrains.getById(grainId);
          if (grain) {
            globalGrains.setActive(grainId);
            return;
          }

          const mainContentElement = document.querySelector("body>.main-content");
          if (mainContentElement) {
            const grainToOpen = globalGrains.addNewGrainView(grainId, path, undefined,
                                                             mainContentElement);
            grainToOpen.openSession();
            globalGrains.setActive(grainId);

            if (initialPopup) {
              globalTopbar.openPopup(initialPopup);
            }
          } else {
            Meteor.defer(openView);
          }
        };

        openView();
      });

      this.next();
    },

    onStop: function () {
      this.state.set("beforeActionHookRan", false);
      globalGrains.setAllInactive();
    },
  });

  this.route("/shared/:token/:path(.*)?", {
    name: "shared",
    template: "grain",
    loadingTemplate: "loadingNoMessage",

    waitOn: function () {
      return [
        Meteor.subscribe("devPackages"),
        Meteor.subscribe("tokenInfo", this.params.token),

        Meteor.subscribe("grainsMenu"),
        // This subscription gives us the data we need for deciding whether to automatically reveal
        // our identity.
        // TODO(soon): Subscribe to contacts instead.
      ];
    },

    onBeforeAction: function () {
      // Only run the hook once.
      if (this.state.get("beforeActionHookRan")) return this.next();
      this.state.set("beforeActionHookRan", true);

      Tracker.nonreactive(() => {
        const token = this.params.token;
        const path = "/" + (this.params.path || "") + (this.originalUrl.match(/[#?].*$/) || "");
        const hash = this.params.hash;

        const tokenInfo = TokenInfo.findOne({ _id: token });
        if (!tokenInfo) {
          return this.next();
        } else if (tokenInfo.invalidToken) {
          this.state.set("invalidToken", true);
        } else if (tokenInfo.revoked) {
          this.state.set("revoked", true);
        } else if (tokenInfo.identityOwner) {
          if (tokenInfo.grainId && Meteor.userId() &&
              globalDb.userHasIdentity(Meteor.userId(), tokenInfo.identityOwner._id)) {
            Router.go("/grain/" + tokenInfo.grainId + path, {}, { replaceState: true });
          } else {
            SandstormDb.fillInPictureUrl(tokenInfo.identityOwner);
            this.state.set("identityOwner", tokenInfo);
          }
        } else if (tokenInfo.alreadyRedeemed) {
          Router.go("/grain/" + tokenInfo.grainId + path, {}, { replaceState: true });
        } else if (tokenInfo.grainId) {
          const grainId = tokenInfo.grainId;

          const openView = function openView() {
            // If the grain is already open in a tab, switch to that tab. We have to re-check this
            // every time we defer to avoid race conditions (especially at startup, with the
            // restore-last-opened code).
            const grain = globalGrains.getById(grainId);
            if (grain) {
              globalGrains.setActive(grainId);
              return;
            }

            const mainContentElement = document.querySelector("body>.main-content");
            if (mainContentElement) {
              const grainToOpen = globalGrains.addNewGrainView(grainId, path, tokenInfo,
                                                               mainContentElement);
              grainToOpen.openSession();
              globalGrains.setActive(grainId);

              if (!Meteor.userId()) {
                // Suggest to the user that they log in by opening the login menu.
                globalTopbar.openPopup("login");
              }
            } else {
              Meteor.defer(openView);
            }
          };

          openView();
        }
      });

      this.next();
    },

    action: function () {
      if (this.state.get("invalidToken")) {
        this.render("invalidToken", { data: { token: this.params.token } });
      } else if (this.state.get("revoked")) {
        this.render("revokedShareLink");
      } else if (this.state.get("identityOwner")) {
        const tokenInfo = this.state.get("identityOwner");
        this.render("wrongIdentity",
                    { data: {
                      recipient: tokenInfo.identityOwner,
                      login: tokenInfo.login,
                    }, });
      } else {
        this.render();
      }
    },

    onStop: function () {
      this.state.set("beforeActionHookRan", false);
      this.state.set("invalidToken", undefined);
      this.state.set("identityOwner", undefined);
      globalGrains.setAllInactive();
    },
  });

  this.route("grainLog", {
    path: "/grainlog/:grainId",
    layoutTemplate: "noLayout",

    waitOn: function () {
      return [
        Meteor.subscribe("grainTopBar", this.params.grainId),
        Meteor.subscribe("grainLog", this.params.grainId),
      ];
    },

    data: function () {
      if (this.ready()) {
        maybeScrollLog();
        const grain = Grains.findOne(this.params.grainId);
        return {
          title: grain ? grain.title : "(deleted grain)",
          // jscs:disable requireCamelCaseOrUpperCaseIdentifiers
          html: AnsiUp.ansi_to_html(GrainLog.find({}, { $sort: { _id: 1 } })
              .map(function (entry) { return entry.text; })
              .join(""), { use_classes:true }),
          // jscs:enable requireCamelCaseOrUpperCaseIdentifiers
        };
      }
    },
  });

  this.route("appDetails", {
    path: "/apps/:appId",
    template: "appDetails",
    waitOn: function () {
      return globalSubs.concat(
        Meteor.subscribe("appIndex", this.params.appId));
    },

    data: function () {
      return new SandstormAppDetails(globalDb, globalQuotaEnforcer, this.params.appId);
    },
  });

  this.route("share", {
    path: "/share/:grainId/:identityId",
    template: "share",
    waitOn: function () {
      return Meteor.subscribe("grainTopBar", this.params.grainId);
    },

    data: function () {
      let userId = Meteor.userId();
      let grainId = this.params.grainId;
      let identityId = this.params.identityId;
      let grain = Grains.findOne({ _id: grainId });
      if (!grain) {
        return { grainNotFound: grainId };
      } else {
        Session.set("share-grain-" + grainId, identityId);
        Router.go("/grain/" + grainId);
      }
    },
  });
});
