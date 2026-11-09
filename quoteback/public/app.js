// Small progressive enhancements. Every page still works without JavaScript.
document.addEventListener('DOMContentLoaded', () => {
  // Confirm before destructive actions.
  document.querySelectorAll('[data-confirm]').forEach((el) => {
    el.addEventListener('submit', (e) => { if (!confirm(el.dataset.confirm)) e.preventDefault(); });
  });

  // Fill the time zone field with the browser's zone on signup.
  document.querySelectorAll('input[data-detect-tz]').forEach((el) => {
    try { if (!el.value) el.value = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { /* keep default */ }
  });

  // Load a chosen CSV file into the paste box.
  const file = document.getElementById('csv-file');
  const box = document.getElementById('csv-text');
  if (file && box) {
    file.addEventListener('change', () => {
      const f = file.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => { box.value = reader.result; };
      reader.readAsText(f);
    });
  }

  document.querySelectorAll('[data-print]').forEach((b) => b.addEventListener('click', () => window.print()));

  // Show the booked amount field only when "Booked" is chosen.
  document.querySelectorAll('select[data-status-select]').forEach((sel) => {
    const extra = document.getElementById(sel.dataset.statusSelect);
    const sync = () => { if (extra) extra.style.display = sel.value === 'booked' ? '' : 'none'; };
    sel.addEventListener('change', sync);
    sync();
  });
});
