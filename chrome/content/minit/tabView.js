"use strict";

TMP_TabView.subScriptLoaded = true;

TMP_TabView.handleEvent = function(aEvent) {
  switch (aEvent.type) {
    case "tabviewshown":
      TabmixSessionManager.saveTabViewData(TabmixSessionManager.gThisWin, true);
      break;
    case "tabviewhidden":
      TabmixSessionManager.saveTabViewData(TabmixSessionManager.gThisWin, true);
      TMP_LastTab.tabs = null;
      if (TabmixTabbar.hideMode != 2) {
        setTimeout(() => gBrowser.tabContainer[Tabmix.updateCloseButtons](), 0);
      }
      break;
    case "TabShow":
      if (!gBrowser.tabContainer._onDelayTabShow) {
        // pass aEvent to this function for use in TGM
        gBrowser.tabContainer._onDelayTabShow = window.setTimeout(event => {
          gBrowser.tabContainer._onDelayTabShow = null;
          TMP_eventListener.onTabOpen_delayUpdateTabBar(event.target);
        }, 0, aEvent);
      }
      break;
    case "TabHide":
      if (!gBrowser.tabContainer._onDelayTabHide) {
        // pass aEvent to this function for use in TGM
        gBrowser.tabContainer._onDelayTabHide = window.setTimeout(event => {
          gBrowser.tabContainer._onDelayTabHide = null;
          let tab = event.target;
          TMP_eventListener.onTabClose_updateTabBar(tab);
        }, 0, aEvent);
      }
      break;
    case "willshowtabview":
      Tabmix.slideshow.cancel();
      break;
  }
};

/* ............... TabView Code Fix  ............... */

/**
 * this code is fixes some bugs in Panorama code when restoring sessions
 *
 */

TMP_TabView._patchBrowserTabview = function SM__patchBrowserTabview() {
  if (TabView.hasOwnProperty("tabmixInitialized")) {
    return;
  }
  TabView.tabmixInitialized = true;

  var tabView = document.getElementById("tab-view-deck");
  if (tabView) {
    tabView.addEventListener("tabviewhidden", this, true);
    tabView.addEventListener("tabviewshown", this, true);
    gBrowser.tabContainer.addEventListener("TabShow", this, true);
    gBrowser.tabContainer.addEventListener("TabHide", this, true);
  }

  // we need to stop tabs slideShow before Tabview starts
  if (window.hasOwnProperty("tabGroups")) {
    // Tab Groups extension by Quicksaver
    // https://addons.mozilla.org/en-US/firefox/addon/tab-groups-panorama/
    window.addEventListener("willshowtabview", this, true);
  } else {
    let $LF = '\n      ';
    Tabmix.changeCode(TabView, "TabView.toggle")._replace(
      'this.show();',
      '{' + $LF +
        '  Tabmix.slideshow.cancel();' + $LF +
        '  $&' + $LF +
        '}'
    ).toCode();
  }

  // don't do anything if Session Manager extension installed
  if (Tabmix.extensions.sessionManager)
    return;

  // add our function to the TabView initFrameCallbacks
  // we don't need our patch for the first run
  var callback = () => {
    try {
      TabmixSessionManager._groupItemPushAway();
      this._patchTabviewFrame();
    } catch (ex) {
      Tabmix.assert(ex);
    }
  };

  if (TabView._window)
    callback();
  else
    TabView._initFrameCallbacks.push(callback);
};

TMP_TabView._patchInitialized = false;
TMP_TabView._patchTabviewFrame = function SM__patchTabviewFrame() {
  // Tab Groups extension by Quicksaver includes these changes in its code
  if (window.hasOwnProperty("tabGroups")) {
    return;
  }

  this._patchInitialized = true;
  TabView._window.GroupItems._original_reconstitute = TabView._window.GroupItems.reconstitute;
  TabView._window.GroupItems.reconstitute = function(groupItemsData, groupItemData) {
    let validate = function(groupItem, data) {
      // This group is re-used by session restore
      // make sure all of its children still belong to this group.
      // Do it before setBounds trigger data save that will overwrite
      // session restore data.
      // TabView will use TabItems.resumeReconnecting or UI.reset to reconnect the tabItem.
      groupItem.getChildren().forEach(tabItem => {
        let tabData = TabmixSessionData.getTabValue(tabItem.tab, "tabview-tab", true);
        if (!tabData || tabData.groupID != data.id) {
          tabItem._reconnected = false;
        }
      });
    };
    if (groupItemData) {
      let storageSanity = this.groupItemStorageSanity || this.storageSanityGroupItem;
      let ids = Object.keys(groupItemData);
      for (let id of ids) {
        let data = groupItemData[id];
        if (storageSanity(data)) {
          let groupItem = this.groupItem(data.id);
          if (groupItem && !groupItem.hidden) {
            validate(groupItem, data);
          }
        }
      }
    }
    this._original_reconstitute.apply(this, arguments);
  };

  if (window.hasOwnProperty("tabGroups")) {
    // reconnect tabs that we disconnected in reconstitute
    TabView._window.UI.reset = function() {
      TabItems.resumeReconnecting();
      this._original_reset.apply(this, arguments);
    };
    return;
  }

  // add tab to the new group on tabs order not tabItem order
  Tabmix.changeCode(TabView._window.UI, "TabView._window.UI.reset")._replace(
    '{',
    '$&' +
    'let win = TabView._window;' +
    'let Trenches = win.Trenches;' +
    'let Items = win.Items;' +
    'let iQ = win.iQ;' +
    'let Rect = win.Rect;' +
    'let GroupItems = win.GroupItems;' +
    'let GroupItem = win.GroupItem;' +
    'let TabItems = win.TabItems;' +
    'let UI = win.UI;', {silent: true}
  )._replace(
    'this.',
    'UI.', {flags: "g", silent: true}
  )._replace(
    /items\.forEach\(function\s*\(item\)\s*\{/,
    'Array.prototype.forEach.call(gBrowser.tabs, function(tab) { \
       if (tab.pinned) return;\
       let item = tab._tabViewTabItem;'
  )._replace(
    /groupItem.add\(.*\);/,
    'item._reconnected = true; \
       $&'
  ).toCode();
};

TMP_TabView._resetTabviewFrame = function SM__resetTabviewFrame() {
  var tabView = document.getElementById("tab-view-deck");
  if (tabView) {
    tabView.removeEventListener("tabviewhidden", this, true);
    tabView.removeEventListener("tabviewshown", this, true);
    gBrowser.tabContainer.removeEventListener("TabShow", this, true);
    gBrowser.tabContainer.removeEventListener("TabHide", this, true);
  }
  window.removeEventListener("willshowtabview", this, true);

  if (this._patchInitialized && TabView._window) {
    TabView._window.GroupItems.reconstitute = TabView._window.GroupItems._original_reconstitute;
    delete TabView._window.GroupItems._original_reconstitute;
    TabView._window.UI.reset = TabView._window.UI._original_reset;
    delete TabView._window.UI._original_reset;
  }
};

/* ............... TabmixSessionManager TabView Data ............... */

// winData: SessionStore window state
TabmixSessionManager._setWindowStateBusy = function(winData) {
  this._beforeRestore(winData);
  if (!this.tabViewInstalled) {
    return;
  }

  this._getSessionTabviewData(winData);
  this._updateUIpageBounds = false;
};

TabmixSessionManager._setWindowStateReady = function(aOverwriteTabs, showNotification, tabsRemoved) {
  if (Tabmix.isVersion(350)) {
    TabmixSvc.SessionStore._setWindowStateReady(window);
  }
  if (!this.tabViewInstalled) {
    this.notifyAboutMissingTabView(tabsRemoved);
    return;
  }

  if (!aOverwriteTabs)
    this._groupItems = this._tabviewData["tabview-group"];

  var parsedData = TabmixSessionData.getWindowValue(window, "tabview-groups", true);
  var groupCount = parsedData.totalNumber || 1;
  TabView.updateGroupNumberBroadcaster(groupCount);

  // show notification
  ///XXX make sure that we have hidden tabs
  if (showNotification && (aOverwriteTabs && groupCount > 1 || groupCount > this._groupCount))
    this.showNotification();

  // update page bounds when we overwrite tabs
  if (aOverwriteTabs || this._updateUIpageBounds)
    this._setPageBounds();

  if (TabView._window && !aOverwriteTabs) {
    // when we don't overwriting tabs try to rearrange the groupItems
    // when TabView._window is false we call this function after tabviewframeinitialized event
    this._groupItemPushAway();
  }

  this.groupUpdates = {};
  this._tabviewData = {};
};

TabmixSessionManager.groupUpdates = {};
TabmixSessionManager._tabviewData = {};
TabmixSessionManager._groupItems = null;

// winData: SessionStore window state
TabmixSessionManager._getSessionTabviewData = function(winData) {
  let extData = winData.extData || {};
  function _fixData(id, parse, def) {
    let data = extData[id] || null;
    if (data) {
      return parse ? TabmixSvc.JSON.parse(data) : data;
    }
    return def;
  }

  let groupItems = _fixData("tabview-group", true, {});
  let groupsData = _fixData("tabview-groups", true, {});
  this._validateGroupsData(groupItems, groupsData);
  this._tabviewData["tabview-group"] = groupItems;
  this._tabviewData["tabview-groups"] = groupsData;
  this.groupUpdates.lastActiveGroupId = groupsData.activeGroupId;

  this._tabviewData["tabview-ui"] = _fixData("tabview-ui", false, TabmixSvc.JSON.stringify({}));
  this._tabviewData["tabview-visibility"] = _fixData("tabview-visibility", false, "false");
};

TabmixSessionManager._saveTabviewData = function SM__saveTabviewData() {
  if (!this.tabViewInstalled) {
    return;
  }

  for (let id of Object.keys(this._tabviewData)) {
    this._setTabviewData(id, this._tabviewData[id]);
  }
};

TabmixSessionManager._setTabviewData = function SM__setTabviewData(id, data) {
  if (typeof (data) != "string")
    data = TabmixSvc.JSON.stringify(data);
  TabmixSvc.ss.setWindowValue(window, id, data);
  if (!this.enableBackup)
    return;
  if (data !== "" && data != "{}")
    this.setLiteral(this.gThisWin, id, data);
  else
    this.removeAttribute(this.gThisWin, id);
};

TabmixSessionManager._setTabviewTab = function SM__setTabviewTab(aTab, tabdata, activeGroupId) {
  if (!this.tabViewInstalled || tabdata.pinned)
    return;

  let parsedData;
  function setData(groupID) {
    let data = {groupID};
    parsedData = data;
    return TabmixSvc.JSON.stringify(data);
  }

  var update = this.groupUpdates;
  var id = "tabview-tab";
  var tabviewData;
  if (update.newGroupID) {
    // We are here only when the restored session did not have tabview data
    // we create new group and fill all the data
    tabviewData = setData(update.newGroupID);
  } else {
    tabviewData = tabdata.extData && tabdata.extData["tabview-tab"] || null;
    // make sure data is not "null"
    if (!tabviewData || tabviewData == "null") {
      if (update.lastActiveGroupId)
        tabviewData = setData(update.lastActiveGroupId);
      else {
        // force Panorama to reconnect all reused tabs
        if (aTab._tabViewTabItem) {
          // remove any old data
          aTab._tabViewTabItem._reconnected = false;
          try {
            TabmixSvc.ss.deleteTabValue(aTab, id);
          } catch (ex) { }
          if (tabdata.extData)
            delete tabdata.extData["tabview-tab"];
        }
        return;
      }
    }

    if (update.IDs) {
      parsedData = TabmixSvc.JSON.parse(tabviewData);
      if (parsedData.groupID in update.IDs) {
        parsedData.groupID = update.IDs[parsedData.groupID];
        tabviewData = TabmixSvc.JSON.stringify(parsedData);
      }
    }
  }

  if (tabviewData) {
    if (!tabdata.extData)
      tabdata.extData = {};
    tabdata.extData["tabview-tab"] = tabviewData;
    // we did not saved hidden attribute when we use TGM
    // hide all tabs that are not in the active group
    if (!Tabmix.extensions.tabGroupManager && activeGroupId !== null) {
      if (!parsedData)
        parsedData = TabmixSvc.JSON.parse(tabviewData);
      if (parsedData.groupID != activeGroupId)
        tabdata.hidden = true;
    }
  } else if (tabdata.extData) {
    delete tabdata.extData["tabview-tab"];
  }
};

TabmixSessionManager.isEmptyObject = function SM_isEmptyObject(obj) {
  return Object.keys(obj).length === 0;
};

// return true if there are no visible tabs that are not in the exclude array
TabmixSessionManager._noNormalTabs = function SM__noNormalTabs(excludeTabs) {
  if (!excludeTabs)
    excludeTabs = [];

  return !Array.prototype.some.call(gBrowser.tabs, tab => {
    return !tab.pinned && !tab.hidden && !tab.closing &&
          excludeTabs.indexOf(tab) == -1;
  });
};

TabmixSessionManager._addGroupItem = function SM__addGroupItem(aGroupItems, aGroupsData, setAsActive) {
  let groupID = aGroupsData.nextID++;
  if (setAsActive) {
    aGroupsData.activeGroupId = groupID;
    this._lastSessionGroupName = "";
  }
  let bounds = {left: 0, top: 0, width: 350, height: 300};
  aGroupItems[groupID] = {bounds, userSize: null, title: "", id: groupID, newItem: true};
  aGroupsData.totalNumber = Object.keys(aGroupItems).length;
  this._tabviewData["tabview-group"] = aGroupItems;
  this._tabviewData["tabview-groups"] = aGroupsData;
};

// Remove current active group only when it's empty and have no title
TabmixSessionManager._deleteActiveGroup = function SM__deleteActiveGroup(aGroupItems, activeGroupId) {
  let activeGroup = aGroupItems[activeGroupId];
  if (activeGroup && activeGroup.title === "") {
    delete aGroupItems[activeGroupId];
    this._tabviewData["tabview-group"] = aGroupItems;
  }
};

// just in case.... and add totalNumber to firefox 4.0 - 5.0.x
TabmixSessionManager._validateGroupsData = function SM__validateGroupsData(aGroupItems, aGroupsData) {
  if (this.isEmptyObject(aGroupItems))
    return;

  if (aGroupsData.nextID && aGroupsData.activeGroupId && aGroupsData.totalNumber)
    return;
  let keys = Object.keys(aGroupItems);
  if (!aGroupsData.nextID) {
    let nextID = 0;
    keys.forEach(key => {
      nextID = Math.max(aGroupItems[key].id, nextID);
    });
    aGroupsData.nextID = nextID++;
  }
  if (!aGroupsData.activeGroupId)
    aGroupsData.activeGroupId = aGroupItems[keys[0]].id;
  if (!aGroupsData.totalNumber)
    aGroupsData.totalNumber = keys.length;
};

/**
 * when we append tab to this window we merge group data from the session into the current group data
 * loadOnStartup: array of tabs that load on startup from application
 * blankTabs: remaining blank tabs in this windows
 */
TabmixSessionManager._prepareTabviewData = function SM__prepareTabviewData(loadOnStartup, blankTabs) {
  if (!this.tabViewInstalled) {
    return;
  }

  let newGroupItems = this._tabviewData["tabview-group"];
  let groupItems = TabmixSessionData.getWindowValue(window, "tabview-group", true);
  let newGroupItemsIsEmpty = this.isEmptyObject(newGroupItems);
  let groupItemsIsEmpty = this.isEmptyObject(groupItems);

  if (newGroupItemsIsEmpty && groupItemsIsEmpty) {
    // just to be on the safe side
    // Tabview will force to add all tabs in one group
    this._tabviewData["tabview-group"] = {};
    this._tabviewData["tabview-groups"] = {};
    return;
  }

  var noNormalVisibleTabs = this._noNormalTabs(blankTabs.concat(loadOnStartup));
  if (!noNormalVisibleTabs)
    this.groupUpdates.hideSessionActiveGroup = true;

  // newGroupItems is not empty
  if (groupItemsIsEmpty) {
    // we can get here also on startup before we set any data to current window

    if (noNormalVisibleTabs)
    // nothing else to do we use this._tabviewData as is.
      this._updateUIpageBounds = true;
    else {
      // Tabview did not started
      // add all normal tabs to new group with the proper id
      let newGroupsData = this._tabviewData["tabview-groups"];
      this._addGroupItem(newGroupItems, newGroupsData, true);

      // update tabs data
      let groupID = newGroupsData.activeGroupId;
      for (let tab of gBrowser.tabs) {
        if (tab.pinned || tab.hidden || tab.closing || blankTabs.indexOf(tab) > -1)
          return;
        let data = {groupID};
        data = TabmixSvc.JSON.stringify(data);
        TabmixSvc.ss.setTabValue(tab, "tabview-tab", data);
        if (this.enableBackup)
          this.setLiteral(this.getNodeForTab(tab), "tabview-tab", data);
      }
    }
    return;
  }

  // groupItems is not empty
  let groupsData = TabmixSessionData.getWindowValue(window, "tabview-groups", true);
  // just in case data was corrupted
  this._validateGroupsData(groupItems, groupsData);

  if (newGroupItemsIsEmpty) {
    let createNewGroup = true;
    if (noNormalVisibleTabs) {
      // if active group is empty without title reuse it for
      // the tabs from the session.
      let activeGroup = groupItems[groupsData.activeGroupId];
      if (activeGroup && activeGroup.title === "") {
        createNewGroup = false;
        this.groupUpdates.newGroupID = groupsData.activeGroupId;
        this._tabviewData["tabview-group"] = groupItems;
        this._tabviewData["tabview-groups"] = groupsData;
      }
    }

    if (createNewGroup) {
      // We create new group here, and set it as active if there is no normal
      // tabs in this window, later we will create "tabview-tab" data in
      // SM__setTabviewTab for each normal tab.
      this.groupUpdates.newGroupID = groupsData.nextID;
      this._addGroupItem(groupItems, groupsData, noNormalVisibleTabs);
    }

    this._tabviewData["tabview-ui"] = TabmixSessionData.getWindowValue(window, "tabview-ui");
    return;
  }

  // both current window and the session that we are restoring have group data

  let IDs = {};
  for (let id of Object.keys(newGroupItems)) {
    newGroupItems[id].newItem = true;
    // change group id if already used in this window
    if (id in groupItems) {
      let newID = groupsData.nextID++;
      groupItems[newID] = newGroupItems[id];
      groupItems[newID].id = newID;
      // we will update tabview-tab data later
      IDs[id] = newID;
    } else {
      groupItems[id] = newGroupItems[id];
      if (id > groupsData.nextID)
        groupsData.nextID = id;
    }
  }

  // When current active group is empty,
  // change active group to the active group from the session we are restoring.
  if (noNormalVisibleTabs) {
    this._deleteActiveGroup(groupItems, groupsData.activeGroupId);
    // set new activeGroupId
    let activeID = this._tabviewData["tabview-groups"].activeGroupId;
    groupsData.activeGroupId = activeID in IDs ? IDs[activeID] : activeID;
    this._updateUIpageBounds = true;
  }

  if (Object.keys(IDs).length > 0) {
    let id = this.groupUpdates.lastActiveGroupId;
    this.groupUpdates.lastActiveGroupId = IDs[id] || id;
    this.groupUpdates.IDs = IDs;
  }

  // update totalNumber
  groupsData.totalNumber = Object.keys(groupItems).length;
  // save data
  this._tabviewData["tabview-group"] = groupItems;
  this._tabviewData["tabview-groups"] = groupsData;
};

TabmixSessionManager.showNotification = function SM_showNotification() {
  var msg = TabmixSvc.getSMString("sm.tabview.hiddengroups");
  try {
    let alerts = Cc["@mozilla.org/alerts-service;1"].getService(Ci.nsIAlertsService);
    alerts.showAlertNotification("chrome://tabmixplus/skin/tmp.png", "Tab Mix Plus", msg, false, "", null);
  } catch (e) { }
};

/* ............... TabView Code Fix  ............... */

// update page bounds when we overwrite tabs
TabmixSessionManager._setPageBounds = function SM__setPageBounds() {
  if (TabView._window) {
    let data = TabmixSessionData.getWindowValue(window, "tabview-ui", true);
    if (this.isEmptyObject(data))
      return;

    let UI = TabView._window.UI;
    let storageSanity = UI._storageSanity || UI.storageSanity;
    if (storageSanity(data) && data.pageBounds) {
      TabView._window.UI._pageBounds = data.pageBounds;
    }
  }
};

// when not overwriting tabs try to rearrange the groupItems
TabmixSessionManager._groupItemPushAway = function SM__groupItemPushAway() {
  if (!this._groupItems)
    return;

  let GroupItems = TabView._window.GroupItems;
  for (let key of Object.keys(this._groupItems)) {
    let data = this._groupItems[key];
    if (data.newItem) {
      let group = GroupItems.groupItem(data.id);
      if (group && GroupItems.groupItemStorageSanity(data)) {
        group.pushAway(true);
      }
    }
  }
  this._groupItems = null;
};
