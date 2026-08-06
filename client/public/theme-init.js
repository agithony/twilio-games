(function () {
  var key = 'twilio-theme';
  var legacyKey = 'twilio-home-theme';
  var theme = 'light';
  try {
    var stored = localStorage.getItem(key);
    var legacy = localStorage.getItem(legacyKey);
    theme = stored === 'dark' || stored === 'light'
      ? stored
      : legacy === 'dark' || legacy === 'light' ? legacy : theme;
    if (!stored) localStorage.setItem(key, theme);
  } catch (_) {}
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#000D25' : '#FFFFFF');
  window.addEventListener('storage', function (event) {
    if (event.key !== key || (event.newValue !== 'dark' && event.newValue !== 'light')) return;
    document.documentElement.dataset.theme = event.newValue;
    document.documentElement.style.colorScheme = event.newValue;
    var currentMeta = document.querySelector('meta[name="theme-color"]');
    if (currentMeta) currentMeta.setAttribute('content', event.newValue === 'dark' ? '#000D25' : '#FFFFFF');
  });
})();
