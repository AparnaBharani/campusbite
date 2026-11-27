const app = document.querySelector("#app");
const toastRegion = document.querySelector("#toast-region");
const gates = ["Amritam Gate", "Vasishta Gate", "Ganga Gate", "Yagnavalkya Gate"];
const canteenNames = { MBA: "MBA Canteen", IT: "IT Canteen", MC: "MC Canteen" };
const foodIcons = { Rolls: "🌯", Snacks: "🥪", Meals: "🍛", Drinks: "🧋" };
const statusLabels = {
  PLACED: "Placed", ACCEPTED: "Accepted", PREPARING: "Preparing", READY: "Ready",
  ASSIGNED: "Rider assigned", PICKED_UP: "Picked up", OUT_FOR_DELIVERY: "On the way",
  DELIVERED: "Delivered", CANCELLED: "Cancelled",
};
const state = { user: null, menu: [], recommendations: [], orders: [], cart: new Map(), filter: "All", search: "", map: null, mapTimer: null, pollTimer: null, polling: false, riders: [] };
const money = (paise) => `₹${(Number(paise) / 100).toFixed(0)}`;
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));
const roleHome = { student: "/student", canteen: "/canteen", rider: "/rider", admin: "/admin" };

async function api(url, options = {}) {
  const headers = { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) };
  if (options.method && options.method !== "GET") headers["X-Requested-With"] = "CampusBite";
  const response = await fetch(url, { credentials: "same-origin", ...options, headers });
  const result = response.status === 204 ? {} : await response.json();
  if (!response.ok) throw new Error(result.error || "Something went wrong.");
  return result;
}

function toast(message, type = "success") {
  const item = document.createElement("div");
  item.className = `toast ${type}`;
  item.textContent = message;
  toastRegion.append(item);
  setTimeout(() => item.remove(), 3500);
}

function currentPath() {
  return location.pathname.replace(/\/+$/, "") || "/";
}

function navigate(path) {
  history.pushState({}, "", path);
  renderRoute();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function cartStorageKey() {
  return `campus-bite-cart:${state.user.id}`;
}

function persistCart() {
  try {
    localStorage.setItem(cartStorageKey(), JSON.stringify([...state.cart]));
  } catch (issue) {
    console.error("Could not save your bag on this device:", issue);
  }
}

function restoreCart() {
  try {
    const stored = JSON.parse(localStorage.getItem(cartStorageKey()) || "[]");
    if (!Array.isArray(stored)) throw new Error("Saved bag has an invalid format.");
    state.cart = new Map(stored.flatMap(([id, quantity]) => {
      const item = state.menu.find((entry) => entry.id === Number(id) && entry.available);
      return item && Number.isSafeInteger(quantity) && quantity > 0 && quantity <= 20
        ? [[item.id, quantity]]
        : [];
    }));
    persistCart();
  } catch (issue) {
    state.cart.clear();
    console.error("Could not restore your saved bag:", issue);
  }
}

function savedGate() {
  try {
    const gate = localStorage.getItem(`campus-bite-gate:${state.user.id}`);
    return gates.includes(gate) ? gate : gates[0];
  } catch (issue) {
    console.error("Could not load your saved campus gate:", issue);
    return gates[0];
  }
}

function saveGate(gate) {
  if (!gates.includes(gate)) return;
  try {
    localStorage.setItem(`campus-bite-gate:${state.user.id}`, gate);
  } catch (issue) {
    console.error("Could not save your campus gate:", issue);
  }
}

function startLiveRefresh(refresh, interval = 15000) {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(async () => {
    if (state.polling || document.visibilityState !== "visible" ||
      document.activeElement?.matches("input, select, textarea")) return;
    state.polling = true;
    try {
      await refresh();
    } catch (issue) {
      console.error("Could not refresh the latest campus data:", issue);
    } finally {
      state.polling = false;
    }
  }, interval);
}

function signInPage(message = "") {
  app.innerHTML = `
    <main class="login-screen">
      <section class="login-card">
        <div class="login-brand"><span class="brand-mark">C</span><div><strong>CampusBite</strong><small>Amrita Ettimadai · Food, thoughtfully delivered</small></div></div>
        <p class="eyebrow">A little more campus, a lot less queue</p>
        <h1>Good food is closer than you think.</h1>
        <p>Sign in with your college email to explore campus menus, order ahead, and follow your delivery to the gate.</p>
        <form id="email-form">
          <div class="field"><label for="email">College email address</label><input id="email" name="email" type="email" placeholder="you@cb.students.amrita.edu" autocomplete="email" required /></div>
          <p class="hint" id="domain-hint">Students can sign in only with an @cb.students.amrita.edu address. Partner and operations accounts are provisioned separately.</p>
          <button class="button button-primary button-block" type="submit">Continue with email <span aria-hidden="true">→</span></button>
          <p class="form-error" id="auth-error">${escapeHtml(message)}</p>
        </form>
        <form id="code-form" class="hidden">
          <div class="field"><label for="code">Six-digit sign-in code</label><input id="code" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required /></div>
          <p class="hint">Check your inbox for the code. It expires in 10 minutes.</p>
          <button class="button button-primary button-block" type="submit">Verify and sign in</button>
          <button class="button button-outline button-block" type="button" id="change-email" style="margin-top:8px">Use a different email</button>
          <p class="form-error" id="auth-error"></p>
        </form>
        <p class="hint" style="margin:22px 0 0">Campus access is limited to verified accounts. Your role is assigned by the service, not selected on this device.</p>
      </section>
    </main>`;

  const emailForm = document.querySelector("#email-form");
  const codeForm = document.querySelector("#code-form");
  const error = document.querySelector("#auth-error");
  let email = "";
  api("/api/config").then(({ studentDomains }) => {
    if (!Array.isArray(studentDomains) || studentDomains.length === 0) throw new Error("No student email domains are configured.");
    document.querySelector("#email").placeholder = `you@${studentDomains[0]}`;
    document.querySelector("#domain-hint").textContent =
      `Students can sign in only with ${studentDomains.map((domain) => `@${domain}`).join(" or ")} addresses. Partner and operations accounts are provisioned separately.`;
  }).catch((issue) => console.error("Could not load sign-in configuration:", issue));
  emailForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    email = new FormData(emailForm).get("email").trim().toLowerCase();
    const button = emailForm.querySelector("button");
    button.disabled = true;
    error.textContent = "";
    try {
      await api("/api/auth/request-code", { method: "POST", body: JSON.stringify({ email }) });
      emailForm.classList.add("hidden");
      codeForm.classList.remove("hidden");
      document.querySelector("#code").focus();
    } catch (issue) {
      error.textContent = issue.message;
    } finally {
      button.disabled = false;
    }
  });
  codeForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = codeForm.querySelector("button[type=submit]");
    const codeError = codeForm.querySelector(".form-error");
    button.disabled = true;
    codeError.textContent = "";
    try {
      const { user } = await api("/api/auth/verify-code", {
        method: "POST",
        body: JSON.stringify({ email, code: new FormData(codeForm).get("code") }),
      });
      state.user = user;
      state.cart = new Map();
      navigate(roleHome[user.role]);
    } catch (issue) {
      codeError.textContent = issue.message;
    } finally {
      button.disabled = false;
    }
  });
  document.querySelector("#change-email").addEventListener("click", () => {
    codeForm.classList.add("hidden");
    emailForm.classList.remove("hidden");
    document.querySelector("#email").focus();
  });
}

function shell(content, active) {
  const links = {
    student: [["/student", "Order food"], ["/orders", "My orders"]],
    canteen: [["/canteen", "Canteen desk"]],
    rider: [["/rider", "My deliveries"]],
    admin: [["/admin", "Campus ops"]],
  }[state.user.role] || [];
  app.innerHTML = `
    <header class="app-header">
      <a class="brand" href="${roleHome[state.user.role]}" data-link><span class="brand-mark">C</span><span class="brand-copy"><strong>CampusBite</strong><small>Amrita Ettimadai</small></span></a>
      <div class="header-right">
        <nav class="app-nav" aria-label="Main navigation">${links.map(([href, label]) => `<a class="nav-link ${href === active ? "active" : ""}" href="${href}" data-link>${label}</a>`).join("")}</nav>
        <div class="account"><strong>${escapeHtml(state.user.email)}</strong><span>${escapeHtml(state.user.role)} account</span></div>
        <button class="button button-outline" id="signout">Sign out</button>
      </div>
    </header>
    <main class="page">${content}</main>
    <footer class="page-footer">CampusBite · A campus-first food delivery concept · OpenStreetMap contributors</footer>`;
  app.querySelectorAll("[data-link]").forEach((link) => link.addEventListener("click", (event) => {
    event.preventDefault();
    navigate(link.getAttribute("href"));
  }));
  document.querySelector("#signout").addEventListener("click", async () => {
    try {
      await api("/api/auth/logout", { method: "POST", body: "{}" });
      if (state.user) {
        try {
          localStorage.removeItem(cartStorageKey());
        } catch (issue) {
          console.error("Could not clear the saved bag:", issue);
        }
      }
      state.user = null;
      state.cart.clear();
      signInPage();
    } catch (issue) {
      toast(issue.message, "error");
    }
  });
}

async function loadStudentData() {
  const [menu, recommendations, orders] = await Promise.all([
    api("/api/menu"), api("/api/recommendations"), api("/api/orders"),
  ]);
  state.menu = menu.items;
  state.recommendations = recommendations.items;
  state.orders = orders.orders;
  restoreCart();
}

function renderStudent() {
  const filtered = state.menu.filter((item) =>
    (state.filter === "All" || item.category === state.filter) &&
    `${item.name} ${item.canteen_id}`.toLowerCase().includes(state.search.toLowerCase()));
  const recommendations = state.recommendations.length
    ? state.recommendations.map((item) => `
      <article class="recommendation">
        <span class="forecast">↗ ${escapeHtml(item.confidence)} forecast · ${item.predicted_demand} orders</span>
        <h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(canteenNames[item.canteen_id])} · ${money(item.price_paise)}</p>
      </article>`).join("")
    : `<div class="recommendation"><span class="forecast">Getting to know the campus</span><h3>Recommendations are warming up</h3><p>More orders make the time-of-day forecast smarter.</p></div>`;
  const cartItems = [...state.cart.entries()];
  const subtotal = cartItems.reduce((sum, [id, quantity]) => sum + Number(state.menu.find((item) => item.id === id)?.price_paise || 0) * quantity, 0);
  const cartMarkup = cartItems.length
    ? `${cartItems.map(([id, quantity]) => {
      const item = state.menu.find((entry) => entry.id === id);
      if (!item) return "";
      return `<div class="cart-line"><div><h3>${escapeHtml(item.name)}</h3><small>${money(item.price_paise)} · ${escapeHtml(canteenNames[item.canteen_id])}</small></div><div class="quantity"><button data-qty="${id}" data-delta="-1" aria-label="Remove one">−</button><span>${quantity}</span><button data-qty="${id}" data-delta="1" aria-label="Add one">+</button></div></div>`;
    }).join("")}
    <div class="field"><label for="gate">Deliver to campus gate</label><select id="gate">${gates.map((gate) => `<option ${gate === savedGate() ? "selected" : ""}>${escapeHtml(gate)}</option>`).join("")}</select></div>
    <div class="cart-line"><span class="subtle">Subtotal</span><strong>${money(subtotal)}</strong></div>
    <div class="cart-line"><span class="subtle">Campus delivery</span><strong>₹25</strong></div>
    <div class="cart-line"><span class="subtle">Platform fee</span><strong>₹2</strong></div>
    <div class="total-row"><span>To pay</span><span>${money(subtotal + 2700)}</span></div>
    <button class="button button-primary button-block" id="place-order" style="margin-top:14px">Place campus order</button>`
    : `<div class="empty-state">Your bag is ready for something delicious.</div>`;

  shell(`
    <section class="hero">
      <div class="hero-copy"><span class="hero-tag">● &nbsp;AMRITA ETTIMADAI · CAMPUS DELIVERY</span><h1>Your next favourite is just around the corner.</h1><p>Discover canteen favourites, skip the queue, and meet your rider at your hostel gate.</p></div>
      <div class="hero-art" aria-hidden="true">🍱</div>
    </section>
    <section class="section-title"><div><h2>Picked for this hour</h2><p>Seasonal forecast from the last 28 days of campus orders.</p></div><span class="subtle">Updates every 5 minutes</span></section>
    <div class="recommendation-strip">${recommendations}</div>
    <section class="section-title"><div><h2>Campus canteens</h2><p>Freshly made, close to your next lecture.</p></div></section>
    <div class="outlet-row">${Object.entries(canteenNames).map(([id, name]) => `<article class="outlet-card"><span class="outlet-icon">${id}</span><h3>${name}</h3><p>Campus favourite · ready in 10–20 min</p></article>`).join("")}</div>
    <section class="section-title"><div><h2>What sounds good?</h2><p>Browse live menus from across campus.</p></div></section>
    <div class="two-column">
      <section>
        <div class="menu-tools"><div class="filters">${["All", "Rolls", "Meals", "Snacks", "Drinks"].map((item) => `<button class="filter ${state.filter === item ? "active" : ""}" data-filter="${item}">${item}</button>`).join("")}</div><input class="search-input" id="menu-search" placeholder="Search campus menu" value="${escapeHtml(state.search)}" /></div>
        <div class="menu-grid">${filtered.length ? filtered.map((item) => `
          <article class="food-card"><div><span class="subtle">${escapeHtml(canteenNames[item.canteen_id])} · ${item.is_veg ? "● Veg" : "▲ Non-veg"}</span><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.category)} · ★ ${Number(item.rating).toFixed(1)}</p><div class="food-price">${money(item.price_paise)}</div><button class="add-button" data-add="${item.id}">ADD</button></div><div class="food-icon">${foodIcons[item.category] || "🍴"}</div></article>`).join("") : `<div class="empty-state">No items match that search.</div>`}</div>
      </section>
      <aside class="panel"><div class="panel-heading"><div><h2>Your bag</h2><p>One canteen per order keeps it fresh.</p></div><span class="brand-mark" style="width:34px;height:34px;font-size:16px">⌑</span></div>${cartMarkup}</aside>
    </div>`, "/student");

  app.querySelectorAll("[data-filter]").forEach((button) => button.addEventListener("click", () => {
    state.filter = button.dataset.filter;
    renderStudent();
  }));
  document.querySelector("#gate")?.addEventListener("change", (event) => saveGate(event.target.value));
  document.querySelector("#menu-search").addEventListener("input", (event) => {
    state.search = event.target.value;
    const position = event.target.selectionStart;
    renderStudent();
    const search = document.querySelector("#menu-search");
    search.focus();
    search.setSelectionRange(position, position);
  });
  app.querySelectorAll("[data-add]").forEach((button) => button.addEventListener("click", () => {
    const id = Number(button.dataset.add);
    const selected = state.menu.find((item) => item.id === id);
    const currentCanteen = [...state.cart.keys()].map((itemId) => state.menu.find((item) => item.id === itemId)?.canteen_id)[0];
    if (currentCanteen && currentCanteen !== selected.canteen_id) {
      toast("Please finish or clear your current canteen order first.", "error");
      return;
    }
    state.cart.set(id, (state.cart.get(id) || 0) + 1);
    persistCart();
    renderStudent();
    toast(`${selected.name} added to your bag.`);
  }));
  app.querySelectorAll("[data-qty]").forEach((button) => button.addEventListener("click", () => {
    const id = Number(button.dataset.qty);
    const quantity = (state.cart.get(id) || 0) + Number(button.dataset.delta);
    if (quantity > 20) return toast("You can add up to 20 of each item.", "error");
    if (quantity <= 0) state.cart.delete(id);
    else state.cart.set(id, quantity);
    persistCart();
    renderStudent();
  }));
  document.querySelector("#place-order")?.addEventListener("click", async () => {
    if (!state.cart.size) return;
    const button = document.querySelector("#place-order");
    button.disabled = true;
    button.textContent = "Placing your order…";
    try {
      const result = await api("/api/orders", {
        method: "POST",
        body: JSON.stringify({ gate: document.querySelector("#gate").value, items: [...state.cart].map(([id, quantity]) => ({ id, quantity })) }),
      });
      state.cart.clear();
      persistCart();
      toast(`Order placed. ${money(result.total_paise)} all in.`);
      await loadStudentData();
      navigate("/orders");
    } catch (issue) {
      toast(issue.message, "error");
    } finally {
      if (button.isConnected) {
        button.disabled = false;
        button.textContent = "Place campus order";
      }
    }
  });
}

function orderCard(order, actions = "") {
  const itemText = (order.items || []).map((item) => `${escapeHtml(item.name)} × ${item.quantity}`).join(" · ");
  return `<article class="order-card">
    <div class="order-top"><div><h3>${escapeHtml(canteenNames[order.canteen_id] || order.canteen_id)} <span class="subtle">· ${escapeHtml(order.id.slice(0, 8).toUpperCase())}</span></h3><p>${new Date(order.created_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</p></div><span class="status ${order.status === "DELIVERED" ? "delivered" : ""}">${escapeHtml(statusLabels[order.status] || order.status)}</span></div>
    <div class="order-items">${itemText}</div>
    <div class="order-meta">Drop: <strong>${escapeHtml(order.gate)}</strong> · Total: <strong>${money(order.total_paise)}</strong>${order.rider_id ? " · Campus rider assigned" : ""}</div>
    ${actions ? `<div class="order-actions">${actions}</div>` : ""}
  </article>`;
}

function renderOrders() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  shell(`<div class="page-heading"><div><p class="eyebrow">Your campus table</p><h1>Orders & delivery</h1><p>Know what’s cooking and where your order is headed.</p></div><button class="button button-outline" id="refresh-orders">Refresh</button></div>
    ${state.orders.length ? `<div class="two-column"><section class="stack">${state.orders.map((order, index) => orderCard(order, order.status !== "DELIVERED" && order.status !== "CANCELLED" ? `<button class="button button-soft" data-track="${index}">Track on map</button>` : "")).join("")}</section><section class="map-panel"><h3>Campus delivery map</h3><div id="order-map" class="map"></div><div class="map-note">Map tiles © OpenStreetMap contributors. Rider movement is a demo simulation; no live GPS is connected.</div></section></div>` : `<div class="panel empty-state">No orders yet. Your next campus favourite is waiting.</div>`}`, "/orders");
  document.querySelector("#refresh-orders")?.addEventListener("click", async () => {
    try {
      state.orders = (await api("/api/orders")).orders;
      renderOrders();
    } catch (issue) { toast(issue.message, "error"); }
  });
  const trackButtons = app.querySelectorAll("[data-track]");
  if (trackButtons.length) {
    const first = state.orders.find((order) => !["DELIVERED", "CANCELLED"].includes(order.status)) || state.orders[0];
    if (first) renderMap(first);
    trackButtons.forEach((button) => button.addEventListener("click", () => renderMap(state.orders[Number(button.dataset.track)])));
  }
    startLiveRefresh(async () => {
      try {
        const { orders } = await api("/api/orders");
        const changed = orders.some((order, index) => order.status !== state.orders[index]?.status) || orders.length !== state.orders.length;
        if (changed) {
          state.orders = orders;
          renderOrders();
        }
      } catch (issue) {
        if (issue.message === "Sign in to continue.") throw issue;
        console.error("Could not refresh order status:", issue);
      }
    }, 10000);
}

function sameRows(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

function renderMap(order) {
  if (!window.L) {
    document.querySelector("#order-map").innerHTML = `<div class="empty-state">The map provider did not load. Check your connection and refresh.</div>`;
    return;
  }
  clearMap();
  const canteen = { MBA: [10.9025, 76.9001], IT: [10.9040, 76.9010], MC: [10.9007, 76.9004] }[order.canteen_id];
  const gate = { "Amritam Gate": [10.9018, 76.9018], "Vasishta Gate": [10.9032, 76.8994], "Ganga Gate": [10.9005, 76.8988], "Yagnavalkya Gate": [10.8995, 76.9021] }[order.gate];
  if (!canteen || !gate) return;
  state.map = L.map("order-map", {
    scrollWheelZoom: false,
    zoomAnimation: false,
    fadeAnimation: false,
    markerZoomAnimation: false,
  }).setView([10.902, 76.900], 16);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(state.map);
  L.marker(canteen).addTo(state.map).bindPopup(`${escapeHtml(canteenNames[order.canteen_id])} · pickup`);
  L.marker(gate).addTo(state.map).bindPopup(`${escapeHtml(order.gate)} · drop-off`);
  const route = [canteen, [(canteen[0] + gate[0]) / 2 + 0.00015, (canteen[1] + gate[1]) / 2], gate];
  L.polyline(route, { color: "#f45b2a", weight: 5, opacity: .82, dashArray: "8 9" }).addTo(state.map);
  const rider = L.marker(canteen, { title: "Campus rider" }).addTo(state.map).bindPopup("Campus rider");
  const moving = order.status === "OUT_FOR_DELIVERY";
  const started = new Date(order.updated_at).getTime();
  const move = () => {
    const progress = moving ? Math.min(.95, Math.max(.08, (Date.now() - started) / (6 * 60 * 1000))) : 0;
    const segment = progress < .5 ? 0 : 1;
    const segmentProgress = (progress - segment * .5) * 2;
    const point = route[segment].map((value, index) => value + (route[segment + 1][index] - value) * segmentProgress);
    rider.setLatLng(point);
  };
  move();
  if (moving) state.mapTimer = setInterval(move, 3000);
  state.map.fitBounds(route, { padding: [28, 28] });
  setTimeout(() => state.map?.invalidateSize(), 50);
}

function clearMap() {
  if (state.mapTimer) {
    clearInterval(state.mapTimer);
    state.mapTimer = null;
  }
  if (state.map) {
    state.map.stop();
    state.map.remove();
    state.map = null;
  }
}

async function renderCanteen() {
  const [orders, menu] = await Promise.all([api("/api/orders"), api("/api/menu")]);
  state.orders = orders.orders;
  state.menu = menu.items;
  const canteenId = state.user.canteen_id;
  const items = state.menu.filter((item) => item.canteen_id === canteenId);
  const relevantOrders = state.orders.filter((order) => !["DELIVERED", "CANCELLED"].includes(order.status));
  shell(`<div class="page-heading"><div><p class="eyebrow">Partner workspace · ${escapeHtml(canteenNames[canteenId] || canteenId)}</p><h1>Good food, smooth service.</h1><p>Manage your live menu and keep campus orders moving.</p></div><span class="status delivered">OUTLET CONNECTED</span></div>
    <div class="stats-grid"><article class="stat-card"><span>Incoming orders</span><strong>${relevantOrders.length}</strong></article><article class="stat-card"><span>Ready to dispatch</span><strong>${relevantOrders.filter((order) => order.status === "READY").length}</strong></article><article class="stat-card"><span>Menu items live</span><strong>${items.length}</strong></article><article class="stat-card"><span>Outlet</span><strong>${escapeHtml(canteenId)}</strong></article></div>
    <div class="two-column">
      <section class="panel"><div class="panel-heading"><div><h2>Order queue</h2><p>Only orders placed with your canteen are shown.</p></div><button class="button button-outline" id="refresh-canteen">Refresh</button></div><div class="stack">${relevantOrders.length ? relevantOrders.map((order) => orderCard(order, canteenActions(order))).join("") : `<div class="empty-state">No new orders. You’re all caught up.</div>`}</div></section>
      <section class="panel">
        <div class="panel-heading"><div><h2>Menu & availability</h2><p>Keep the menu accurate for students.</p></div></div>
        <form id="new-menu-item" class="menu-form">
          <label class="field"><span>Dish name</span><input name="name" maxlength="80" placeholder="e.g. Masala dosa" required /></label>
          <label class="field"><span>Category</span><select name="category"><option>Meals</option><option>Rolls</option><option>Snacks</option><option>Drinks</option></select></label>
          <label class="field"><span>Price (₹)</span><input name="price_rupees" type="number" min="1" max="10000" step="1" placeholder="45" required /></label>
          <label class="field"><span>Dietary type</span><select name="is_veg"><option value="true">Vegetarian</option><option value="false">Non-vegetarian</option></select></label>
          <button class="button button-primary button-block" type="submit">Add menu item</button>
          <p class="form-error" id="menu-error" role="status"></p>
        </form>
        <div class="stack">${items.map((item) => `<article class="cart-line"><div><h3>${escapeHtml(item.name)}</h3><small>${money(item.price_paise)} · ${escapeHtml(item.category)}</small></div><label class="subtle"><input type="checkbox" data-availability="${item.id}" ${item.available ? "checked" : ""} /> Available</label></article>`).join("")}</div>
      </section>
    </div>`, "/canteen");
  document.querySelector("#refresh-canteen").addEventListener("click", renderCanteen);
  app.querySelectorAll("[data-status]").forEach((button) => button.addEventListener("click", () => updateOrder(button.dataset.id, button.dataset.status, renderCanteen)));
  document.querySelector("#new-menu-item").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector("button[type=submit]");
    const error = document.querySelector("#menu-error");
    const fields = new FormData(form);
    button.disabled = true;
    error.textContent = "";
    try {
      await api("/api/menu", {
        method: "POST",
        body: JSON.stringify({
          name: fields.get("name"),
          category: fields.get("category"),
          price_rupees: Number(fields.get("price_rupees")),
          is_veg: fields.get("is_veg") === "true",
        }),
      });
      toast("Menu item added.");
      await renderCanteen();
    } catch (issue) {
      error.textContent = issue.message;
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  });
  app.querySelectorAll("[data-availability]").forEach((input) => input.addEventListener("change", async () => {
    try {
      await api(`/api/menu/${input.dataset.availability}/availability`, { method: "PATCH", body: JSON.stringify({ available: input.checked }) });
      toast("Menu availability updated.");
    } catch (issue) { input.checked = !input.checked; toast(issue.message, "error"); }
  }));
  startLiveRefresh(async () => {
    const [orders, menu] = await Promise.all([api("/api/orders"), api("/api/menu")]);
    if (!sameRows(orders.orders, state.orders) || !sameRows(menu.items, state.menu)) {
      await renderCanteen();
    }
  });
}

function canteenActions(order) {
  const next = { PLACED: ["ACCEPTED", "Accept order"], ACCEPTED: ["PREPARING", "Start preparing"], PREPARING: ["READY", "Mark ready"] }[order.status];
  return next ? `<button class="button button-primary" data-id="${escapeHtml(order.id)}" data-status="${next[0]}">${next[1]}</button>` : "";
}

async function updateOrder(id, status, refresh) {
  try {
    await api(`/api/orders/${encodeURIComponent(id)}/status`, { method: "PATCH", body: JSON.stringify({ status }) });
    toast("Order status updated.");
    await refresh();
  } catch (issue) { toast(issue.message, "error"); }
}

async function renderRider() {
  const orders = (await api("/api/orders")).orders;
  state.orders = orders;
  const active = state.orders.filter((order) => !["DELIVERED", "CANCELLED"].includes(order.status));
  shell(`<div class="page-heading"><div><p class="eyebrow">Campus delivery partner</p><h1>Every handoff matters.</h1><p>Your assigned campus deliveries, all in one place.</p></div><span class="status">${active.length} ACTIVE</span></div>
    <div class="role-note">Delivery route previews use OpenStreetMap. This pilot simulates rider movement; connect approved device GPS before using it for live dispatch.</div>
    <section class="section-title"><div><h2>My delivery queue</h2><p>Pickup, ride, and complete each handoff.</p></div></section>
    ${state.orders.length ? `    <div class="two-column"><section class="stack">${state.orders.map((order) => orderCard(order, riderActions(order))).join("")}</section><section class="map-panel"><h3>Delivery route</h3><div id="order-map" class="map"></div><div class="map-note">Approximate campus positions · route is illustrative.</div></section></div>` : `<div class="panel empty-state">No deliveries are assigned to your account yet.</div>`}`, "/rider");
  app.querySelectorAll("[data-status]").forEach((button) => button.addEventListener("click", () => updateOrder(button.dataset.id, button.dataset.status, renderRider)));
  const first = state.orders.find((order) => !["DELIVERED", "CANCELLED"].includes(order.status)) || state.orders[0];
  if (first) renderMap(first);
  startLiveRefresh(async () => {
    const freshOrders = (await api("/api/orders")).orders;
    if (!sameRows(freshOrders, state.orders)) await renderRider();
  });
}

function riderActions(order) {
  const next = { ASSIGNED: ["PICKED_UP", "Confirm pickup"], PICKED_UP: ["OUT_FOR_DELIVERY", "Start delivery"], OUT_FOR_DELIVERY: ["DELIVERED", "Confirm delivery"] }[order.status];
  return next ? `<button class="button button-primary" data-id="${escapeHtml(order.id)}" data-status="${next[0]}">${next[1]}</button>` : "";
}

async function renderAdmin() {
  const [analytics, orders, riders] = await Promise.all([api("/api/analytics"), api("/api/orders"), api("/api/riders")]);
  state.orders = orders.orders;
  state.riders = riders.riders;
  shell(`<div class="page-heading"><div><p class="eyebrow">Campus operations</p><h1>One campus, in sync.</h1><p>Live order flow and shared rider capacity at a glance.</p></div><button class="button button-outline" id="refresh-admin">Refresh data</button></div>
    <div class="stats-grid"><article class="stat-card"><span>Total campus orders</span><strong>${analytics.total_orders}</strong></article><article class="stat-card"><span>Ready for a rider</span><strong>${analytics.ready}</strong></article><article class="stat-card"><span>Riders available</span><strong>${analytics.available} / ${analytics.total_riders}</strong></article><article class="stat-card"><span>Delivered</span><strong>${analytics.delivered}</strong></article></div>
    <section class="panel"><div class="panel-heading"><div><h2>Dispatch & order flow</h2><p>Assign a ready order to an available, provisioned campus rider.</p></div></div><div class="stack">${state.orders.length ? state.orders.map((order) => {
      const available = state.riders.filter((rider) => !rider.busy);
      const assign = order.status === "READY" && available.length ? `<select class="field-select" id="rider-${escapeHtml(order.id)}">${available.map((rider) => `<option value="${escapeHtml(rider.id)}">${escapeHtml(rider.email)}</option>`).join("")}</select><button class="button button-primary" data-assign="${escapeHtml(order.id)}">Assign rider</button>` : "";
      return orderCard(order, assign);
    }).join("") : `<div class="empty-state">No campus orders yet.</div>`}</div></section>`, "/admin");
  document.querySelector("#refresh-admin").addEventListener("click", renderAdmin);
  app.querySelectorAll("[data-assign]").forEach((button) => button.addEventListener("click", async () => {
    const riderId = document.querySelector(`#rider-${CSS.escape(button.dataset.assign)}`)?.value;
    if (!riderId) return toast("No available rider is configured.", "error");
    try {
      await api(`/api/orders/${encodeURIComponent(button.dataset.assign)}/assign`, { method: "POST", body: JSON.stringify({ rider_id: riderId }) });
      toast("Rider assigned to the order.");
      await renderAdmin();
    } catch (issue) { toast(issue.message, "error"); }
  }));
  startLiveRefresh(async () => {
    const [freshAnalytics, freshOrders, freshRiders] = await Promise.all([
      api("/api/analytics"), api("/api/orders"), api("/api/riders"),
    ]);
    if (!sameRows(freshOrders.orders, state.orders) ||
      !sameRows(freshRiders.riders, state.riders) ||
      !sameRows(freshAnalytics, analytics)) {
      await renderAdmin();
    }
  });
}

async function renderRoute() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  clearMap();
  if (!state.user) {
    signInPage();
    return;
  }
  const path = currentPath();
  const destination = roleHome[state.user.role];
  if (path === "/") {
    navigate(destination);
    return;
  }
  const rolesByPath = { "/student": "student", "/orders": "student", "/canteen": "canteen", "/rider": "rider", "/admin": "admin" };
  if (!rolesByPath[path] || rolesByPath[path] !== state.user.role) {
    navigate(destination);
    return;
  }
  try {
    if (path === "/student") {
      await loadStudentData();
      renderStudent();
    } else if (path === "/orders") {
      state.orders = (await api("/api/orders")).orders;
      renderOrders();
    } else if (path === "/canteen") {
      await renderCanteen();
    } else if (path === "/rider") {
      await renderRider();
    } else if (path === "/admin") {
      await renderAdmin();
    }
  } catch (issue) {
    if (issue.message === "Sign in to continue." || issue.message.includes("session expired")) {
      state.user = null;
      signInPage("Your session expired. Sign in again.");
    } else {
      app.innerHTML = `<main class="page"><div class="panel"><h1>We couldn't load this page.</h1><p class="hint">${escapeHtml(issue.message)}</p><button class="button button-primary" onclick="location.reload()">Try again</button></div></main>`;
    }
  }
}

window.addEventListener("popstate", renderRoute);
try {
  const { user } = await api("/api/auth/me");
  state.user = user;
  await renderRoute();
} catch {
  signInPage();
}
