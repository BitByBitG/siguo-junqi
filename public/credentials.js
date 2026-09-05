const credentialForm = document.querySelector("#credential-form");
credentialForm.addEventListener("submit", async event => {
  event.preventDefault();
  const result = document.querySelector("#result"), button = credentialForm.querySelector("button");
  const data = Object.fromEntries(new FormData(credentialForm));
  if (data.password !== data.confirm) { result.textContent = "两次输入的密码不一致"; return; }
  button.disabled = true;
  try {
    const changing = location.pathname === "/password.html";
    const auth = JSON.parse(localStorage.getItem("junqi-auth") || "null");
    const response = await fetch(changing ? "/api/password" : "/api/register", { method: "POST", headers: { "content-type": "application/json", ...(changing ? { Authorization: "Bearer " + (auth?.token || "") } : {}) }, body: JSON.stringify(data) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "操作失败");
    result.textContent = body.message;
    credentialForm.reset();
    if (changing) { localStorage.removeItem("junqi-auth"); localStorage.removeItem("junqi-session"); }
  } catch (error) { result.textContent = error.message; }
  finally { button.disabled = false; }
});
