fetch("/api/auth/me", { credentials: "include" }).then((res) => {
  if (res.ok) window.location.href = "/collection.html";
});
