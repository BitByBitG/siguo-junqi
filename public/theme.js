(() => {
  function apply() {
    const enabled = localStorage.getItem("junqi-stealth") === "1";
    document.body.classList.toggle("stealth-mode", enabled);
    document.querySelectorAll("[data-stealth]").forEach(button => {
      button.textContent = enabled ? "退出隐蔽" : "隐蔽模式";
      button.setAttribute("aria-pressed", String(enabled));
    });
    window.dispatchEvent(new Event("junqi-theme"));
  }
  document.querySelectorAll("[data-stealth]").forEach(button => button.onclick = () => {
    localStorage.setItem("junqi-stealth", localStorage.getItem("junqi-stealth") === "1" ? "0" : "1"); apply();
  });
  window.addEventListener("storage", event => { if (event.key === "junqi-stealth") apply(); });
  window.addEventListener("junqi-theme-refresh", apply);
  apply();
})();
