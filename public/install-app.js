// Botão "Instalar app" — aparece na tela de login e ao lado da logo no app.
// Chrome/Edge: instala com 1 clique. Safari/Firefox: mostra o passo a passo.
(function () {
  var deferred = null;
  var standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  if (standalone) return; // já está rodando como app

  function ua() { return navigator.userAgent || ''; }
  function help() {
    var isSafari = /Safari/.test(ua()) && !/Chrome|Chromium|Edg/.test(ua());
    var isIOS = /iPhone|iPad|iPod/.test(ua());
    var msg = isIOS
      ? 'No iPhone/iPad: toque em Compartilhar e depois em "Adicionar à Tela de Início".'
      : isSafari
        ? 'No Safari (Mac): menu Arquivo > "Adicionar ao Dock".'
        : 'Abra no Chrome ou Edge e clique no ícone de instalar na barra de endereço (ou menu ⋮ > Instalar NEXT GAME).';
    alert(msg);
  }
  function click() {
    if (deferred) {
      deferred.prompt();
      deferred.userChoice.finally(function () { deferred = null; });
    } else help();
  }
  function make(cls) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'install-app-btn ' + (cls || '');
    b.textContent = '⬇ Instalar app';
    b.title = 'Instalar o NEXT GAME no seu computador ou celular';
    b.addEventListener('click', click);
    return b;
  }
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferred = e; });
  window.addEventListener('appinstalled', function () {
    document.querySelectorAll('.install-app-btn').forEach(function (b) { b.remove(); });
  });

  function mount() {
    var hero = document.querySelector('.auth-hero-topbar');
    if (hero && !hero.querySelector('.install-app-btn')) hero.appendChild(make('install-app-hero'));
    var card = document.getElementById('auth-card');
    var title = document.getElementById('auth-card-title');
    if (card && title && !card.querySelector('.install-app-btn')) card.insertBefore(make('install-app-card'), title);
    var logo = document.querySelector('.app-sidebar-logo');
    if (logo && !logo.querySelector('.install-app-btn')) logo.appendChild(make('install-app-side'));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
