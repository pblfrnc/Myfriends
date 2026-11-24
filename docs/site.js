// Abas de instalação, botão de copiar e a conversa de exemplo aparecendo em sequência.
document.documentElement.classList.add('js');
const tabs = [...document.querySelectorAll('[role=tab]')];
function select(tab) {
  for (const t of tabs) {
    const on = t === tab;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
  }
}
tabs.forEach((t, i) => {
  t.addEventListener('click', () => select(t));
  t.addEventListener('keydown', (e) => {
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    const next = tabs[(i + d + tabs.length) % tabs.length];
    select(next); next.focus();
  });
});
const copied = document.documentElement.lang === 'en' ? 'Copied' : 'Copiado';
document.querySelectorAll('.copy').forEach((b) => {
  const label = b.textContent;
  b.addEventListener('click', async () => {
    const text = b.previousElementSibling.textContent;
    try { await navigator.clipboard.writeText(text); b.textContent = copied; } catch { b.textContent = '⌘C'; }
    setTimeout(() => { b.textContent = label; }, 1600);
  });
});
const items = [...document.querySelectorAll('.log li')];
if (matchMedia('(prefers-reduced-motion: reduce)').matches) items.forEach((li) => li.classList.add('in'));
else items.forEach((li, i) => setTimeout(() => li.classList.add('in'), 250 + i * 650));
