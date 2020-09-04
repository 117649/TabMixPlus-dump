/* globals TabmixSessionManager */
/* exported gSessionPane */
"use strict";

var gSessionPane = {
  gSessionManager: null,
  init() {
    if (TabmixSvc.isLinux)
      $("sessionManager-panels").setAttribute("linux", "true");

    this.setVisibleContent(Boolean(this.sessionManagerAddon), true);

    gPrefWindow.setDisabled("obs_ss_postdata", $("pref_ss_postdata").value == 2);
    this.isSessionStoreEnabled(true);
    this.updateSessionShortcuts();

    gPrefWindow.initPane("paneSession");
  },

  updateSessionShortcuts() {
    if (typeof gMenuPane == "object")
      gMenuPane.updateSessionShortcuts();
  },

  isSessionStoreEnabled(onStart) {
    if (this.gSessionManager)
      return;

    var sessionStoreEnabled = Services.prefs.getIntPref("browser.startup.page") == 3 ||
        Services.prefs.getBoolPref("browser.sessionstore.resume_from_crash");
    $("sessionsOptions").checked = sessionStoreEnabled;
    $("sessionsPanel").setAttribute("manager", !sessionStoreEnabled ? "tabmix" : "firefox");
    if (!onStart || sessionStoreEnabled)
      $("session").selectedIndex = sessionStoreEnabled ? 2 : 0;
    else if ($("session").selectedIndex == 2)
      $("session").selectedIndex = 0;
  },

  setSessionsOptions(item) {
    let instantApply = document.documentElement.instantApply;
    var useSessionManager = !item.checked;
    $("sessionsPanel").setAttribute("manager", useSessionManager ? "tabmix" : "firefox");

    function updatePrefs(aItemId, aValue) {
      let preference = $("pref_" + aItemId);
      preference.batching = true;
      if (instantApply)
        preference.value = aValue;
      else {
        preference.valueFromPreferences = aValue;
        let index = gPrefWindow.changes.indexOf(preference);
        if (index > -1)
          gPrefWindow.changes.splice(index, 1);
      }
      preference.batching = false;
    }

    // TMP session pref
    let sessionPrefs = function() {
      updatePrefs("sessionManager", useSessionManager);
      updatePrefs("sessionCrashRecovery", useSessionManager);
    };

    // sessionstore pref
    function sessionstorePrefs() {
      updatePrefs("browser.warnOnQuit", !useSessionManager);
      updatePrefs("resume_from_crash", !useSessionManager);
      // "browser.startup.page"
      updatePrefs("browserStartupPage", useSessionManager ? 1 : 3);
    }

    TabmixSvc.sm.settingPreference = true;
    if (useSessionManager) {
      sessionstorePrefs();
      sessionPrefs();
    } else {
      sessionPrefs();
      sessionstorePrefs();
    }
    TabmixSvc.sm.settingPreference = false;

    if (instantApply)
      Services.prefs.savePrefFile(null);
    else
      gPrefWindow.setButtons(!gPrefWindow.changes.length);
  },

  setSessionpath(val) {
    var menuItem = $("onStart.popup").getElementsByAttribute("value", val)[0];
    $("pref_sessionpath").value = menuItem.getAttribute("session");
  },

  get sessionManagerAddon() {
    if (TabmixSvc.sessionManagerAddonInstalled) {
      let tmp = {};
      Components.utils.import("chrome://sessionmanager/content/modules/session_manager.jsm", tmp);
      return tmp.gSessionManager;
    }
    let win = Tabmix.getTopWin();
    let sm = win.com && win.com.morac && win.com.morac.SessionManagerAddon;
    return sm && sm.gSessionManager || sm;
  },

  setVisibleContent(sessionManagerInstalled, onStart) {
    if (typeof sessionManagerInstalled != "boolean")
      return;

    // disable TMP session manager setting if session manager extension is install
    $("sessionmanager_ext_tab").hidden = !sessionManagerInstalled;
    $("sessionStore_tab").hidden = sessionManagerInstalled;
    $("paneSession-tabbox").selectedIndex = sessionManagerInstalled ? 0 : 1;
    if (sessionManagerInstalled) {
      $("sessionmanager_button").setAttribute("image", "chrome://sessionmanager/skin/icon.png");
      if (onStart)
        $("chooseFile").selectedIndex = 1;
    } else {
      this.isSessionStoreEnabled(onStart);
      TabmixSessionManager.createMenuForDialog($("onStart.popup"));
      $("onStart.loadsession").value = $("pref_onStart.loadsession").value;
    }
  },

  sessionManagerOptions() {
    this.sessionManagerAddon.openOptions();
  },

  convertSession() {
    var browserWindow = Tabmix.getTopWin();
    if ($("chooseFile").selectedItem.value == "0")
      browserWindow.TabmixConvertSession.selectFile(window);
    else
      browserWindow.TabmixConvertSession.convertFile();

    window.focus();
  }

};
