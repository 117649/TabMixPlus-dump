Components.utils.import("resource://gre/modules/Services.jsm");

let appinfo = Services.appinfo;
let options = {
  application: appinfo.ID,
  appversion: appinfo.version,
  platformversion: appinfo.platformVersion,
  os: appinfo.OS,
  osversion: Services.sysinfo.getProperty("version"),
  abi: appinfo.XPCOMABI
};

let man = `
overlay   chrome://browser/content/browser.xhtml                 chrome://tabmixplus/content/tabmix.xhtml
overlay   chrome://browser/content/browser.xhtml                 chrome://tabmixplus/content/overlay/tabstoolbar.xhtml appversion>=31.0b1
`;

function showRestartNotifcation(verb, window) {
  window.PopupNotifications._currentNotifications.shift();
  window.PopupNotifications.show(
    window.gBrowser.selectedBrowser,
    'addon-install-restart',
    'Tab Mix Plus has been ' + verb + ', but a restart is required to ' + (verb == 'upgraded' || verb == 're-enabled' ? 'enable' : 'remove') + ' add-on functionality.',
    'addons-notification-icon',
    {
      label: 'Restart Now',
      accessKey: 'R',
      callback() {
        window.BrowserUtils.restartApplication();
      }
    },
    [{
      label: 'Not Now',
      accessKey: 'N',
      callback: () => {},
    }],
    {
      popupIconURL: 'chrome://tabmixplus/skin/addon-install-restart.svg',
      persistent: false,
      hideClose: true,
      timeout: Date.now() + 30000,
      removeOnDismissal: true
    }
  );
}

function install() { }

function uninstall() { }

function startup(data, reason) {
//   var temp = {};
//   Services.scriptloader.loadSubScript("chrome://s3downbar/content/prefs.js", temp, 'UTF-8');
//   delete temp;

  Components.utils.import("chrome://tabmixplus/content/ChromeManifest.jsm");
  Components.utils.import("chrome://tabmixplus/content/Overlays.jsm");
  Components.utils.import("resource:///modules/CustomizableUI.jsm");

  const window = Services.wm.getMostRecentWindow('navigator:browser');
  if (reason === ADDON_UPGRADE || reason === ADDON_DOWNGRADE) {
      showRestartNotifcation("upgraded", window);
      return;
  } /* else if (reason === ADDON_ENABLE && window.Tabmix) {
      showRestartNotifcation("re-enabled", window);
      return;
  } */

  if (reason === ADDON_INSTALL || (reason === ADDON_ENABLE && !window.Tabmix)) {
    var enumerator = Services.wm.getEnumerator(null);
    while (enumerator.hasMoreElements()) {
      var win = enumerator.getNext();

      (async function (win) {
        let chromeManifest = new ChromeManifest(function () { return man; }, options);
        await chromeManifest.parse();
        if (win.document.createXULElement) {
          Overlays.load(chromeManifest, win.document.defaultView);
        }
      })(win);
    }
  }

//   var stringBundle = Services.strings.createBundle('chrome://s3downbar/locale/downbar.properties?' + Math.random());
//   CustomizableUI.createWidget({
//     id: 's3downbar_mini',
//     type: 'custom',
//     defaultArea: CustomizableUI.AREA_NAVBAR,
//     onBuild: function (aDocument) {
//       var toolbaritem = aDocument.createXULElement('toolbarbutton');
//       var props = {
//         id: 's3downbar_mini',
//         label: stringBundle.GetStringFromName('extensions.s3download@statusbar.name'),
//         tooltiptext: stringBundle.GetStringFromName('extensions.s3download@statusbar.name') + ' Mini',
//         context: 's3downbar_barcontext',
//         class: 'toolbarbutton-1 chromeclass-toolbar-additional',
//         onclick: 's3downbar.action.show_mini_popup(this, event);'
//       };
//       for (var p in props) {
//         toolbaritem.setAttribute(p, props[p]);
//       }
//       var hb = aDocument.createXULElement('hbox');
//       hb.setAttribute('id', 's3downbar_mini_hbox');
//       hb.setAttribute('collapsed', 'true');
//       hb.setAttribute('class', 'toolbarbutton-icon');
//       var hbIm = hb.appendChild(aDocument.createXULElement('image'));
//       hbIm.setAttribute('id', 's3downbar_mini_image');
//       var hbLbl = hb.appendChild(aDocument.createXULElement('label'));
//       hbLbl.setAttribute('id', 's3downbar_mini_text');
//       hbLbl.setAttribute('value', '0:0');
//       var img = aDocument.createXULElement('image');
//       img.setAttribute('id', 's3downbar_mini_image_custom');
//       toolbaritem.appendChild(hb);
//       toolbaritem.appendChild(img);

//       return toolbaritem;
//     }
//   });

  (async function () {
    let chromeManifest = new ChromeManifest(function () { return man; }, options);
    await chromeManifest.parse();

    let documentObserver = {
      observe(document) {
        if (document.createXULElement) {
          Overlays.load(chromeManifest, document.defaultView);
        }
      }
    };
    Services.obs.addObserver(documentObserver, "chrome-document-loaded");
  })();
}

function shutdown(data, reason) {
  const window = Services.wm.getMostRecentWindow('navigator:browser');
  if (reason === ADDON_DISABLE) {
      showRestartNotifcation("disabled", window);
      return;
  } else if (reason === ADDON_UNINSTALL /* && window.Tabmix */) {
      showRestartNotifcation("uninstalled", window);
      return;
  }
}
