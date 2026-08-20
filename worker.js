var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js — Viraasat POS Enterprise FINAL 6.2
var JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept"
};
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: JSON_HEADERS
  });
}
__name(json, "json");
function clean(value) {
  if (value === void 0 || value === null) return "";
  return String(value).trim();
}
__name(clean, "clean");
function num(value, fallback = 0) {
  if (typeof value === "string") {
    value = value.replace(/₹/g, "").replace(/,/g, "").trim();
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
__name(num, "num");
function bool(value, fallback = true) {
  if (value === void 0 || value === null) return fallback;
  const v = String(value).trim().toLowerCase();
  if (v === "no" || v === "false" || v === "0" || v === "inactive") {
    return false;
  }
  return true;
}
__name(bool, "bool");
function todayIST() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(/* @__PURE__ */ new Date());
}
__name(todayIST, "todayIST");
function makeOrderNumber() {
  return "ORD" + Date.now().toString().slice(-10);
}
__name(makeOrderNumber, "makeOrderNumber");
function normalizeDate(value) {
  if (!value) return todayIST();
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return s;
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    return todayIST();
  }
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(d);
}
__name(normalizeDate, "normalizeDate");
async function tableExists(db, table) {
  const result = await db.prepare(
    `SELECT name
       FROM sqlite_master
       WHERE type='table'
       AND name=?`
  ).bind(table).first();
  return !!result;
}
__name(tableExists, "tableExists");
async function getColumns(db, table) {
  if (!await tableExists(db, table)) {
    return [];
  }
  const result = await db.prepare(`PRAGMA table_info(${table})`).all();
  return (result.results || []).map((row) => row.name);
}
__name(getColumns, "getColumns");
async function ensureColumn(db, table, column, definition) {
  const cols = await getColumns(db, table);
  if (!cols.includes(column)) {
    try {
      await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
    } catch (e) {
      // If another request added it concurrently, continue; otherwise surface the error.
      const colsAfter = await getColumns(db, table);
      if (!colsAfter.includes(column)) throw e;
    }
  }
}
__name(ensureColumn, "ensureColumn");
async function ensureSupportTables(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS stock_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      quantity REAL DEFAULT 0,
      unit TEXT DEFAULT 'pcs',
      low_stock_level REAL DEFAULT 5,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS stock_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stock_item_id INTEGER,
      item_name TEXT NOT NULL,
      old_quantity REAL DEFAULT 0,
      new_quantity REAL DEFAULT 0,
      change_quantity REAL DEFAULT 0,
      action TEXT DEFAULT 'UPDATE',
      note TEXT,
      updated_by TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS staff (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      mobile TEXT,
      role TEXT,
      salary REAL DEFAULT 0,
      join_date TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT,
      amount REAL,
      description TEXT,
      expense_date TEXT,
      receipt_image TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
  const expCols = await getColumns(db, "expenses");
  if (expCols.length > 0 && !expCols.includes("receipt_image")) {
    try {
      await db.prepare(
        "ALTER TABLE expenses ADD COLUMN receipt_image TEXT"
      ).run();
    } catch (e) {
      console.error(e);
    }
  }
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS deletion_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL,
      requested_by TEXT,
      reason TEXT,
      status TEXT DEFAULT 'pending',
      reviewed_by TEXT,
      reviewed_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_deletion_requests_pending ON deletion_requests(order_id,status)`).run();

  // Legacy compatibility: an earlier approval build used approval_requests.
  // Keep it readable and migrate any unresolved requests into the canonical table.
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS approval_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL,
      reason TEXT,
      requested_by TEXT,
      status TEXT DEFAULT 'pending',
      reviewed_by TEXT,
      reviewed_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_approval_requests_status ON approval_requests(status)`).run();
  await db.prepare(`
    INSERT INTO deletion_requests (order_id, requested_by, reason, status, reviewed_by, reviewed_at, created_at)
    SELECT a.order_id, a.requested_by, a.reason, COALESCE(a.status,'pending'), a.reviewed_by, a.reviewed_at, a.created_at
    FROM approval_requests a
    WHERE NOT EXISTS (
      SELECT 1 FROM deletion_requests d
      WHERE d.order_id=a.order_id
        AND COALESCE(d.created_at,'')=COALESCE(a.created_at,'')
    )
  `).run();
  // Legacy rows are copied into the canonical deletion_requests table above.
  // Mark legacy pending rows as migrated so the approval API never returns duplicate
  // request IDs from two tables (which previously caused Approve/Reject to target the wrong row).
  await db.prepare(`UPDATE approval_requests SET status='migrated' WHERE LOWER(COALESCE(status,'pending'))='pending'`).run();

  // Migration-safe: older Viraasat databases may already have deletion_requests
  // without the newer review/request metadata columns.
  await ensureColumn(db, "deletion_requests", "requested_by", "TEXT");
  await ensureColumn(db, "deletion_requests", "reason", "TEXT");
  await ensureColumn(db, "deletion_requests", "status", "TEXT DEFAULT 'pending'");
  await ensureColumn(db, "deletion_requests", "reviewed_by", "TEXT");
  await ensureColumn(db, "deletion_requests", "reviewed_at", "TEXT");
  await ensureColumn(db, "deletion_requests", "created_at", "TEXT");
  await db.prepare(`UPDATE deletion_requests SET created_at=CURRENT_TIMESTAMP WHERE created_at IS NULL`).run();
}
__name(ensureSupportTables, "ensureSupportTables");
async function getMenu(db) {
  if (!await tableExists(db, "menu_items")) {
    return [];
  }
  const cols = await getColumns(db, "menu_items");
  const id = cols.includes("id") ? "id" : "rowid AS id";
  const name = cols.includes("name") ? "name" : "'' AS name";
  const category = cols.includes("category") ? "category" : "'' AS category";
  const price = cols.includes("price") ? "price" : "0 AS price";
  const gst = cols.includes("gst_percent") ? "COALESCE(gst_percent,0) AS gst_percent" : "0 AS gst_percent";
  const active = cols.includes("is_available") ? "COALESCE(is_available,1) AS is_available" : "1 AS is_available";
  const result = await db.prepare(`
    SELECT
      ${id},
      ${name},
      ${category},
      ${price},
      ${gst},
      ${active}
    FROM menu_items
    ORDER BY category, name
  `).all();
  return result.results || [];
}
__name(getMenu, "getMenu");
async function getTables(db) {
  if (!await tableExists(db, "restaurant_tables")) {
    return [];
  }
  const cols = await getColumns(
    db,
    "restaurant_tables"
  );
  const id = cols.includes("id") ? "id" : "rowid AS id";
  const tableNumber = cols.includes("table_number") ? "table_number" : "'' AS table_number";
  const seating = cols.includes("seating_area") ? "seating_area" : "'' AS seating_area";
  const status = cols.includes("status") ? "status" : "'available' AS status";
  const currentOrder = cols.includes("current_order_id") ? "current_order_id" : "NULL AS current_order_id";
  const result = await db.prepare(`
    SELECT
      ${id},
      ${tableNumber},
      ${seating},
      ${status},
      ${currentOrder}
    FROM restaurant_tables
    ORDER BY CAST(table_number AS INTEGER)
  `).all();
  return result.results || [];
}
__name(getTables, "getTables");
async function getOrderItemsMap(db, orderIds) {
  const map = {};
  if (!orderIds.length || !await tableExists(db, "order_items")) {
    return map;
  }
  const cols = await getColumns(
    db,
    "order_items"
  );
  const has = /* @__PURE__ */ __name((c) => cols.includes(c), "has");
  const nameExpr = has("item_name") ? "item_name" : has("name") ? "name" : "''";
  const qtyExpr = has("quantity") ? "quantity" : has("qty") ? "qty" : "1";
  const priceExpr = has("price") ? "price" : has("unit_price") ? "unit_price" : "0";
  const totalExpr = has("total") ? "total" : `(${priceExpr})*(${qtyExpr})`;
  const menuIdExpr = has("menu_item_id") ? "menu_item_id" : "NULL";
  const oidExpr = has("order_id") ? "order_id" : "NULL";
  const qs = orderIds.map(() => "?").join(",");
  const rows = await db.prepare(`
    SELECT
      ${oidExpr} AS order_id,
      ${menuIdExpr} AS menu_item_id,
      ${nameExpr} AS item_name,
      ${qtyExpr} AS quantity,
      ${priceExpr} AS price,
      ${totalExpr} AS total
    FROM order_items
    WHERE order_id IN (${qs})
    ORDER BY order_id DESC, rowid ASC
  `).bind(...orderIds).all();
  for (const r of rows.results || []) {
    const key = String(r.order_id);
    if (!map[key]) {
      map[key] = [];
    }
    map[key].push({
      id: r.menu_item_id || null,
      name: r.item_name || "",
      qty: num(r.quantity, 1),
      quantity: num(r.quantity, 1),
      price: num(r.price),
      unit_price: num(r.price),
      total: num(r.total)
    });
  }
  return map;
}
__name(getOrderItemsMap, "getOrderItemsMap");
async function getOrders(db, limit = 500) {
  if (!await tableExists(db, "orders")) {
    return [];
  }
  const cols = await getColumns(
    db,
    "orders"
  );
  const pick = /* @__PURE__ */ __name((column, fallback) => cols.includes(column) ? column : fallback, "pick");
  const grandTotalExp = cols.includes("grand_total") ? "grand_total" : cols.includes("total") ? "total AS grand_total" : "0 AS grand_total";
  const result = await db.prepare(`
    SELECT
      ${pick("id", "rowid AS id")},
      ${pick(
    "order_number",
    "CAST(id AS TEXT) AS order_number"
  )},
      ${pick(
    "order_type",
    "'Takeaway' AS order_type"
  )},
      ${pick(
    "table_number",
    "NULL AS table_number"
  )},
      ${pick(
    "customer_phone",
    "'' AS customer_phone"
  )},
      ${pick(
    "subtotal",
    "0 AS subtotal"
  )},
      ${pick(
    "discount",
    "0 AS discount"
  )},
      ${grandTotalExp},
      ${pick(
    "payment_method",
    "'' AS payment_method"
  )},
      ${pick(
    "payment_status",
    "'' AS payment_status"
  )},
      ${pick(
    "order_status",
    "'completed' AS order_status"
  )},
      ${pick(
    "items",
    "'' AS items"
  )},
      ${pick(
    "items_string",
    "'' AS items_string"
  )},
      ${pick(
    "created_at",
    "NULL AS created_at"
  )}
    FROM orders
    ORDER BY id DESC
    LIMIT ?
  `).bind(
    Math.min(
      Math.max(num(limit, 500), 1),
      5e3
    )
  ).all();
  const orders = result.results || [];
  const ids = orders.map((o) => Number(o.id)).filter(Number.isFinite);
  const itemMap = await getOrderItemsMap(db, ids);
  return orders.map((o) => {
    const details = itemMap[String(o.id)] || [];
    let items = o.items;
    let itemsString = o.items_string;
    if (details.length) {
      items = JSON.stringify(details);
      if (!itemsString) {
        itemsString = details.map(
          (i) => `${clean(i.name)} (x${num(i.qty, 1)}) \u20B9${num(i.total)}`
        ).join(", ");
      }
    }
    return {
      ...o,
      items,
      items_string: itemsString,
      item_details: details
    };
  });
}
__name(getOrders, "getOrders");
async function getExpenses(db, limit = 1e3) {
  if (!await tableExists(db, "expenses")) {
    return [];
  }
  const cols = await getColumns(db, "expenses");
  const pick = /* @__PURE__ */ __name((column, fallback) => cols.includes(column) ? column : fallback, "pick");
  const result = await db.prepare(`
    SELECT
      ${pick("id", "rowid AS id")},
      ${pick(
    "category",
    "'' AS category"
  )},
      ${pick(
    "amount",
    "0 AS amount"
  )},
      ${pick(
    "description",
    "'' AS description"
  )},
      ${pick(
    "expense_date",
    "NULL AS expense_date"
  )},
      ${pick(
    "receipt_image",
    "NULL AS receipt_image"
  )},
      ${pick(
    "created_at",
    "NULL AS created_at"
  )}
    FROM expenses
    ORDER BY id DESC
    LIMIT ?
  `).bind(
    Math.min(
      Math.max(num(limit, 1e3), 1),
      5e3
    )
  ).all();
  return result.results || [];
}
__name(getExpenses, "getExpenses");
async function getStock(db) {
  await ensureSupportTables(db);
  const result = await db.prepare(`
    SELECT
      id,
      name,
      quantity,
      unit,
      low_stock_level,
      is_active,
      created_at,
      updated_at
    FROM stock_items
    ORDER BY name
  `).all();
  return result.results || [];
}
__name(getStock, "getStock");
async function getStaff(db) {
  await ensureSupportTables(db);
  // Portal should show only active staff. Removed/inactive staff remain in D1
  // for historical integrity but must not reappear after a refresh.
  const result = await db.prepare(`
    SELECT
      id, name, mobile, role, salary, join_date, is_active, created_at
    FROM staff
    WHERE COALESCE(is_active,1)=1
      AND LOWER(TRIM(COALESCE(name,''))) NOT LIKE 'sample %'
      AND LOWER(TRIM(COALESCE(name,''))) <> 'sample'
    ORDER BY name, id DESC
  `).all();

  // Defensive de-duplication: same mobile OR same normalized name is one portal record.
  const seenMobile = new Set();
  const seenName = new Set();
  const out = [];
  for (const row of (result.results || [])) {
    const mobile = String(row.mobile || '').replace(/\D/g,'');
    const name = String(row.name || '').trim().toLowerCase();
    if ((mobile && seenMobile.has(mobile)) || (name && seenName.has(name))) continue;
    if (mobile) seenMobile.add(mobile);
    if (name) seenName.add(name);
    out.push(row);
  }
  return out;
}
__name(getStaff, "getStaff");
async function getDashboard(db) {
  const [
    orders,
    expenses,
    tables,
    stock,
    staff
  ] = await Promise.all([
    getOrders(db, 5e3),
    getExpenses(db, 5e3),
    getTables(db),
    getStock(db),
    getStaff(db)
  ]);
  const today = todayIST();
  const validOrders = orders.filter((order) => {
    const status = String(
      order.order_status || "completed"
    ).toLowerCase();
    return status !== "cancelled" && status !== "deleted";
  });
  const todayOrders = validOrders.filter(
    (order) => String(
      order.created_at || ""
    ).startsWith(today)
  );
  const todaySales = todayOrders.reduce(
    (sum, order) => sum + num(order.grand_total),
    0
  );
  const overallSales = validOrders.reduce(
    (sum, order) => sum + num(order.grand_total),
    0
  );
  const totalExpenses = expenses.reduce(
    (sum, exp) => sum + num(exp.amount),
    0
  );
  const todayExpenses = expenses.filter(
    (exp) => String(
      exp.expense_date || exp.created_at || ""
    ).startsWith(today)
  ).reduce(
    (sum, exp) => sum + num(exp.amount),
    0
  );
  const averageOrder = todayOrders.length ? todaySales / todayOrders.length : 0;
  const occupiedTables = tables.filter(
    (table) => String(
      table.status || ""
    ).toLowerCase() === "occupied"
  ).length;
  const activeStaff = staff.filter(
    (s) => Number(s.is_active) === 1
  ).length;
  return {
    success: true,
    summary: {
      today_sales: todaySales,
      today_orders: todayOrders.length,
      average_order: averageOrder,
      overall_sales: overallSales,
      total_expenses: totalExpenses,
      today_expenses: todayExpenses,
      net_profit: overallSales - totalExpenses,
      active_staff: activeStaff
    },
    tables: {
      total: tables.length,
      occupied: occupiedTables,
      available: Math.max(
        tables.length - occupiedTables,
        0
      )
    },
    stock,
    staff
  };
}
__name(getDashboard, "getDashboard");
async function updateTable(db, tableNumber, status, orderId = null) {
  if (!tableNumber || !await tableExists(
    db,
    "restaurant_tables"
  )) {
    return;
  }
  const cols = await getColumns(
    db,
    "restaurant_tables"
  );
  const updates = [];
  const values = [];
  if (cols.includes("status")) {
    updates.push("status=?");
    values.push(status);
  }
  if (cols.includes(
    "current_order_id"
  )) {
    updates.push(
      "current_order_id=?"
    );
    values.push(orderId);
  }
  if (cols.includes("updated_at")) {
    updates.push(
      "updated_at=CURRENT_TIMESTAMP"
    );
  }
  if (!updates.length) {
    return;
  }
  await db.prepare(`
    UPDATE restaurant_tables
    SET ${updates.join(",")}
    WHERE CAST(table_number AS TEXT)=?
  `).bind(
    ...values,
    String(tableNumber)
  ).run();
}
__name(updateTable, "updateTable");
function parseItemsString(itemsString) {
  if (!itemsString) {
    return [];
  }
  let text = String(itemsString).replace(
    /\[Discount Applied:[^\]]+\]/gi,
    ""
  ).replace(
    /\[Mode:[^\]]+\]/gi,
    ""
  ).trim();
  const parts = text.split(",").map((x) => x.trim()).filter(Boolean);
  const items = [];
  for (const part of parts) {
    const match = part.match(
      /^(.+?)\s*\(x\s*(\d+(?:\.\d+)?)\)\s*₹\s*([\d,.]+)\s*$/i
    );
    if (!match) {
      continue;
    }
    const name = clean(match[1]);
    const quantity = num(match[2], 1);
    const total = num(match[3]);
    const price = quantity > 0 ? total / quantity : total;
    items.push({
      name,
      qty: quantity,
      price,
      total
    });
  }
  return items;
}
__name(parseItemsString, "parseItemsString");
async function resolveMenuItemId(db, item) {
  const cols = await getColumns(
    db,
    "menu_items"
  );
  if (!cols.length) {
    throw new Error(
      "menu_items table not found"
    );
  }
  const suppliedId = num(
    item.id || item.menu_item_id
  );
  if (suppliedId && cols.includes("id")) {
    const found = await db.prepare(`
        SELECT id, name
        FROM menu_items
        WHERE id=?
        LIMIT 1
      `).bind(suppliedId).first();
    if (found) {
      return Number(found.id);
    }
  }
  const itemName = clean(
    item.name || item.item_name
  );
  if (!itemName) {
    throw new Error(
      "Menu item name is missing"
    );
  }
  if (cols.includes("name")) {
    const found = await db.prepare(`
        SELECT id, name
        FROM menu_items
        WHERE lower(trim(name)) =
              lower(trim(?))
        LIMIT 1
      `).bind(itemName).first();
    if (found) {
      return Number(found.id);
    }
  }
  if (cols.includes("id") && cols.includes("name")) {
    const menuFields = [];
    const menuValues = [];
    menuFields.push("name");
    menuValues.push(itemName);
    if (cols.includes("category")) {
      menuFields.push("category");
      menuValues.push(
        clean(item.category) || "Imported"
      );
    }
    if (cols.includes("price")) {
      menuFields.push("price");
      menuValues.push(
        num(item.price)
      );
    }
    if (cols.includes("gst_percent")) {
      menuFields.push(
        "gst_percent"
      );
      menuValues.push(
        num(
          item.gst_percent || item.gst
        )
      );
    }
    if (cols.includes("is_available")) {
      menuFields.push(
        "is_available"
      );
      menuValues.push(1);
    }
    const result = await db.prepare(`
        INSERT INTO menu_items
        (${menuFields.join(",")})
        VALUES
        (${menuFields.map(() => "?").join(",")})
      `).bind(...menuValues).run();
    const newId = result.meta?.last_row_id ?? result.lastInsertRowid ?? null;
    if (newId) {
      return Number(newId);
    }
  }
  throw new Error(
    `Unable to resolve menu item: ${itemName}`
  );
}
__name(resolveMenuItemId, "resolveMenuItemId");
async function createOrder(db, body) {
  const cols = await getColumns(
    db,
    "orders"
  );
  const orderNumber = clean(
    body.order_number || body.orderNumber
  ) || makeOrderNumber();
  if (cols.includes("order_number")) {
    const existing = await db.prepare(`
        SELECT id, order_number
        FROM orders
        WHERE order_number=?
        LIMIT 1
      `).bind(orderNumber).first();
    if (existing) {
      return {
        orderId: existing.id,
        orderNumber: existing.order_number,
        duplicate: true
      };
    }
  }
  const tableNumber = clean(
    body.table_number || body.tableNumber
  );
  const orderType = clean(
    body.order_type || body.orderType
  ) || (tableNumber ? "Dine-in" : "Takeaway");
  let items = Array.isArray(body.items) ? body.items : [];
  if (!items.length && body.items_string) {
    items = parseItemsString(
      body.items_string
    );
  }
  const resolvedItems = [];
  for (const rawItem of items) {
    const item = {
      ...rawItem
    };
    item.name = clean(
      item.name || item.item_name
    );
    item.qty = num(
      item.qty ?? item.quantity,
      1
    );
    item.price = num(
      item.price ?? item.unit_price
    );
    item.total = num(
      item.total,
      item.price * item.qty
    );
    item.menu_item_id = await resolveMenuItemId(
      db,
      item
    );
    item.id = item.menu_item_id;
    resolvedItems.push(item);
  }
  items = resolvedItems;
  const subtotal = num(
    body.subtotal,
    items.reduce(
      (sum, item) => sum + num(
        item.total,
        num(item.price) * num(item.qty, 1)
      ),
      0
    )
  );
  const discount = num(body.discount);
  const grandTotal = num(
    body.grand_total ?? body.total,
    Math.max(
      subtotal - discount,
      0
    )
  );
  const paymentMethod = clean(
    body.payment_method || body.paymentMethod
  ) || "Cash";
  const customerPhone = clean(
    body.customer_phone || body.phone
  ) || "NA";
  const values = {};
  const add = /* @__PURE__ */ __name((column, value) => {
    if (cols.includes(column)) {
      values[column] = value;
    }
  }, "add");
  add(
    "order_number",
    orderNumber
  );
  add(
    "order_type",
    orderType
  );
  add(
    "table_number",
    tableNumber || null
  );
  add(
    "customer_phone",
    customerPhone
  );
  add(
    "subtotal",
    subtotal
  );
  add(
    "discount",
    discount
  );
  add(
    "gst",
    num(body.gst)
  );
  add(
    "grand_total",
    grandTotal
  );
  add(
    "total",
    grandTotal
  );
  add(
    "payment_method",
    paymentMethod
  );
  add(
    "payment_status",
    body.payment_status || "paid"
  );
  add(
    "order_status",
    body.order_status || "completed"
  );
  add(
    "items",
    JSON.stringify(items)
  );
  add(
    "items_string",
    body.items_string || items.map(
      (item) => `${clean(item.name)} (x${num(item.qty, 1)}) \u20B9${num(item.total, num(item.price) * num(item.qty, 1))}`
    ).join(", ")
  );
  add(
    "created_at",
    body.created_at || (/* @__PURE__ */ new Date()).toISOString()
  );
  add(
    "updated_at",
    (/* @__PURE__ */ new Date()).toISOString()
  );
  const fields = Object.keys(values);
  if (!fields.length) {
    throw new Error(
      "orders table structure is incompatible"
    );
  }
  const result = await db.prepare(`
      INSERT INTO orders
      (${fields.join(",")})
      VALUES
      (${fields.map(() => "?").join(",")})
    `).bind(
    ...fields.map(
      (field) => values[field]
    )
  ).run();
  const orderId = result.meta?.last_row_id ?? result.lastInsertRowid ?? null;
  if (orderId && await tableExists(
    db,
    "order_items"
  )) {
    const itemCols = await getColumns(
      db,
      "order_items"
    );
    for (const item of items) {
      const itemValues = {};
      const addItem = /* @__PURE__ */ __name((column, value) => {
        if (itemCols.includes(
          column
        )) {
          itemValues[column] = value;
        }
      }, "addItem");
      addItem(
        "order_id",
        orderId
      );
      addItem(
        "menu_item_id",
        item.menu_item_id || item.id || null
      );
      if (itemCols.includes(
        "item_name"
      )) {
        addItem(
          "item_name",
          clean(item.name)
        );
      } else if (itemCols.includes("name")) {
        addItem(
          "name",
          clean(item.name)
        );
      }
      addItem(
        "quantity",
        num(item.qty, 1)
      );
      if (itemCols.includes("qty")) {
        addItem(
          "qty",
          num(item.qty, 1)
        );
      }
      if (itemCols.includes("price")) {
        addItem(
          "price",
          num(item.price)
        );
      }
      if (itemCols.includes(
        "unit_price"
      )) {
        addItem(
          "unit_price",
          num(item.price)
        );
      }
      if (itemCols.includes(
        "gst_percent"
      )) {
        addItem(
          "gst_percent",
          num(
            item.gst_percent || item.gst || 0
          )
        );
      }
      addItem(
        "total",
        num(
          item.total,
          num(item.price) * num(item.qty, 1)
        )
      );
      const itemFields = Object.keys(
        itemValues
      );
      if (!itemFields.length) {
        continue;
      }
      await db.prepare(`
        INSERT INTO order_items
        (${itemFields.join(",")})
        VALUES
        (${itemFields.map(() => "?").join(",")})
      `).bind(
        ...itemFields.map(
          (field) => itemValues[field]
        )
      ).run();
    }
  }
  return {
    orderId,
    orderNumber,
    grandTotal,
    duplicate: false
  };
}
__name(createOrder, "createOrder");
var worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();
    if (method === "OPTIONS") {
      return new Response(
        null,
        {
          status: 204,
          headers: JSON_HEADERS
        }
      );
    }
    try {
      const db = env.DB;
      if (!db) {
        return json(
          {
            success: false,
            error: "D1 Database Binding is missing"
          },
          500
        );
      }
      if (path === "/") {
        return new Response(
          "Viraasat POS Enterprise API Running",
          {
            status: 200
          }
        );
      }
      if (path === "/api/health") {
        return json({
          success: true,
          application: "Viraasat POS Enterprise",
          status: "online",
          database: "connected",
          binding: !!env.DB
        });
      }
      if (path === "/api/test-db") {
        const check = await db.prepare(
          "SELECT 1 AS ok"
        ).first();
        return json({
          success: true,
          application: "Viraasat POS Enterprise",
          database: "D1 connected",
          binding: "DB",
          result: check
        });
      }
      if (path === "/api/routes" && method === "GET") {
        return json({
          success:true,
          routes:[
            "GET /api/health","GET /api/test-db","GET /api/dashboard","GET /api/menu","POST /api/menu",
            "GET /api/tables","POST /api/tables/clear","GET /api/orders","POST /api/orders","POST /api/orders/checkout",
            "POST /api/orders/request-delete","GET /api/approvals","GET /api/approvals/debug","POST /api/approvals/resolve",
            "GET /api/expenses","POST /api/expenses","GET /api/staff","POST /api/staff","POST /api/staff/update",
            "POST /api/staff/remove","POST /api/staff/status","POST /api/import/full"
          ]
        });
      }

      if (path === "/api/dashboard" && method === "GET") {
        return json(
          await getDashboard(db)
        );
      }
      if (path === "/api/menu" && method === "GET") {
        return json({
          success: true,
          items: await getMenu(db)
        });
      }
      if (path === "/api/menu" && method === "POST") {
        const body = await request.json();
        const name = clean(body.name);
        if (!name) {
          return json(
            {
              success: false,
              error: "Menu name required"
            },
            400
          );
        }
        const cols = await getColumns(
          db,
          "menu_items"
        );
        const fields = [];
        const values = [];
        if (cols.includes("name")) {
          fields.push("name");
          values.push(name);
        }
        if (cols.includes("category")) {
          fields.push("category");
          values.push(
            clean(body.category)
          );
        }
        if (cols.includes("price")) {
          fields.push("price");
          values.push(
            num(body.price)
          );
        }
        if (cols.includes(
          "gst_percent"
        )) {
          fields.push(
            "gst_percent"
          );
          values.push(
            num(body.gst_percent)
          );
        }
        if (cols.includes(
          "is_available"
        )) {
          fields.push(
            "is_available"
          );
          values.push(
            body.is_available === false ? 0 : 1
          );
        }
        const result = await db.prepare(`
            INSERT INTO menu_items
            (${fields.join(",")})
            VALUES
            (${fields.map(() => "?").join(",")})
          `).bind(...values).run();
        return json({
          success: true,
          id: result.meta?.last_row_id ?? null
        });
      }
      if (path === "/api/tables" && method === "GET") {
        return json({
          success: true,
          tables: await getTables(db)
        });
      }
      if (path === "/api/tables/clear" && method === "POST") {
        const body = await request.json();
        await updateTable(
          db,
          clean(
            body.table_number || body.tableNumber
          ),
          "available",
          null
        );
        return json({
          success: true
        });
      }
      if (path === "/api/orders" && method === "GET") {
        const limit = url.searchParams.get(
          "limit"
        ) || 500;
        return json({
          success: true,
          orders: await getOrders(
            db,
            limit
          )
        });
      }
      if (path === "/api/orders" && method === "POST") {
        const body = await request.json();
        const result = await createOrder(
          db,
          body
        );
        const tableNumber = clean(
          body.table_number || body.tableNumber
        );
        if (tableNumber && !result.duplicate) {
          await updateTable(
            db,
            tableNumber,
            "occupied",
            result.orderId
          );
        }
        return json({
          success: true,
          ...result
        });
      }
      if (path === "/api/orders/checkout" && method === "POST") {
        const body = await request.json();
        body.payment_status = "paid";
        body.order_status = "completed";
        const result = await createOrder(
          db,
          body
        );
        const tableNumber = clean(
          body.table_number || body.tableNumber
        );
        if (tableNumber && !result.duplicate) {
          await updateTable(
            db,
            tableNumber,
            "available",
            null
          );
        }
        return json({
          success: true,
          ...result
        });
      }
      if (path === "/api/orders/request-delete" && method === "POST") {
        await ensureSupportTables(db);
        const body = await request.json();
        const orderId = clean(body.order_id || body.orderNumber || body.order_number || body.id);
        const reason = clean(body.reason) || "Deletion requested from POS";
        const requestedBy = clean(body.requested_by || body.requestedBy) || "Admin";
        if (!orderId) return json({ success:false, error:"Order ID is required" },400);

        const existing = await db.prepare(`
          SELECT id, order_id, status
          FROM deletion_requests
          WHERE (order_id=? OR order_id=CAST(? AS TEXT)) AND status='pending'
          ORDER BY id DESC LIMIT 1
        `).bind(orderId, orderId).first();

        if (existing) {
          return json({ success:true, already_pending:true, id:existing.id, message:"Deletion request is already pending approval" });
        }

        const inserted = await db.prepare(`
          INSERT INTO deletion_requests (order_id, requested_by, reason, status, created_at)
          VALUES (?, ?, ?, 'pending', CURRENT_TIMESTAMP)
        `).bind(orderId, requestedBy, reason).run();

        const orderCols = await getColumns(db,"orders");
        if (orderCols.includes("order_status")) {
          await db.prepare(`
            UPDATE orders SET order_status='deletion_pending'
            WHERE order_number=? OR CAST(id AS TEXT)=?
          `).bind(orderId, orderId).run();
        }

        return json({
          success:true,
          id:inserted.meta?.last_row_id ?? inserted.lastInsertRowid ?? null,
          message:"Deletion request submitted for approval"
        });
      }
      if (path === "/api/approvals" && method === "GET") {
        await ensureSupportTables(db);
        const requests = await db.prepare(`
          SELECT id, order_id, requested_by, reason, status, reviewed_by, reviewed_at, created_at
          FROM deletion_requests
          WHERE LOWER(COALESCE(status,'pending'))='pending'
          ORDER BY id DESC
        `).all();
        const rows = Array.isArray(requests.results) ? requests.results : [];
        return json({success:true,count:rows.length,requests:rows});
      }
      if (path === "/api/approvals/debug" && method === "GET") {
        await ensureSupportTables(db);
        const all = await db.prepare(`
          SELECT id, order_id, requested_by, reason, status, reviewed_by, reviewed_at, created_at
          FROM deletion_requests
          ORDER BY id DESC LIMIT 50
        `).all();
        return json({
          success:true,
          count:(all.results||[]).length,
          requests:all.results||[]
        });
      }
      if (path === "/api/approvals/resolve" && method === "POST") {
        await ensureSupportTables(db);
        const body = await request.json();
        const requestId = num(body.request_id || body.id);
        const status = clean(body.status).toLowerCase();
        const orderId = clean(body.order_id || body.orderNumber || body.order_number);
        const reviewedBy = clean(body.reviewed_by || body.reviewedBy) || "Admin";

        if (!requestId || !["approved","rejected"].includes(status)) {
          return json({ success:false, error:"Valid request_id and status (approved/rejected) are required" },400);
        }

        let reqRow = await db.prepare(`SELECT * FROM deletion_requests WHERE id=? LIMIT 1`).bind(requestId).first();
        let sourceTable = 'deletion_requests';
        if (!reqRow) {
          reqRow = await db.prepare(`SELECT * FROM approval_requests WHERE id=? LIMIT 1`).bind(requestId).first();
          sourceTable = 'approval_requests';
        }
        if (!reqRow) return json({ success:false, error:"Approval request not found" },404);
        if (clean(reqRow.status).toLowerCase() !== "pending") {
          return json({ success:false, error:"Approval request is already resolved" },409);
        }

        const targetOrder = orderId || clean(reqRow.order_id);

        if (String(targetOrder).startsWith("STAFF:")) {
          const staffId = num(String(targetOrder).slice(6));
          if (!staffId) return json({success:false,error:"Invalid staff approval target"},400);
          const staffRow = await db.prepare(`SELECT id, name, mobile, is_active FROM staff WHERE id=? LIMIT 1`).bind(staffId).first();
          if (!staffRow) return json({success:false,error:"Staff record not found"},404);
          if (status === "approved") {
            // Remove the selected employee and any duplicate record carrying the same
            // mobile/name. This prevents a duplicate row from making a successful
            // approval look like the employee was not removed.
            const mobile = String(staffRow.mobile || '').replace(/\D/g,'');
            const name = String(staffRow.name || '').trim().toLowerCase();
            let result;
            if (mobile) {
              result = await db.prepare(`
                UPDATE staff SET is_active=0, updated_at=CURRENT_TIMESTAMP
                WHERE REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(mobile,''),' ',''),'-',''),'+',''), '(', '') LIKE ?
                   OR id=?
              `).bind(`%${mobile}%`, staffId).run();
            } else {
              result = await db.prepare(`
                UPDATE staff SET is_active=0, updated_at=CURRENT_TIMESTAMP
                WHERE LOWER(TRIM(COALESCE(name,'')))=? OR id=?
              `).bind(name, staffId).run();
            }
            const affected = Number(result?.meta?.changes || result?.changes || 0);
            if (affected < 1) return json({success:false,error:"Staff record could not be deactivated"},500);
          }

          // Only mark the approval resolved after the protected action succeeded.
          await db.prepare(`
            UPDATE ${sourceTable}
            SET status=?, reviewed_by=?, reviewed_at=CURRENT_TIMESTAMP
            WHERE id=?
          `).bind(status, reviewedBy, requestId).run();

          if (status === "approved") {
            return json({success:true,message:`Staff removal approved and removed from POS.`,staff_id:staffId,status,affected:1});
          }
          return json({success:true,message:`Staff removal request rejected`,staff_id:staffId,status,affected:0});
        }

        // Orders: resolve the approval and then apply the order status.
        await db.prepare(`
          UPDATE ${sourceTable}
          SET status=?, reviewed_by=?, reviewed_at=CURRENT_TIMESTAMP
          WHERE id=?
        `).bind(status, reviewedBy, requestId).run();

        const orderCols = await getColumns(db,"orders");
        if (orderCols.includes("order_status")) {
          const nextStatus = status === "approved" ? "deleted" : "completed";
          await db.prepare(`
            UPDATE orders SET order_status=?
            WHERE order_number=? OR CAST(id AS TEXT)=?
          `).bind(nextStatus, targetOrder, targetOrder).run();
        }

        return json({ success:true, message:`Request ${status}`, order_id:targetOrder, status });
      }
      if (path === "/api/expenses" && method === "GET") {
        const limit = Math.min(
          Math.max(
            num(
              url.searchParams.get(
                "limit"
              ) || 1e3,
              1
            ),
            1
          ),
          5e3
        );
        return json({
          success: true,
          expenses: await getExpenses(
            db,
            limit
          )
        });
      }
      if (path === "/api/expenses" && method === "POST") {
        await ensureSupportTables(
          db
        );
        const body = await request.json();
        const cols = await getColumns(
          db,
          "expenses"
        );
        const fields = [];
        const values = [];
        if (cols.includes("category")) {
          fields.push("category");
          values.push(
            clean(body.category)
          );
        }
        if (cols.includes("amount")) {
          fields.push("amount");
          values.push(
            num(body.amount)
          );
        }
        if (cols.includes("description")) {
          fields.push(
            "description"
          );
          values.push(
            clean(body.description)
          );
        }
        if (cols.includes(
          "expense_date"
        )) {
          fields.push(
            "expense_date"
          );
          values.push(
            normalizeDate(
              body.expense_date
            )
          );
        }
        if (cols.includes(
          "receipt_image"
        ) && body.receipt_image) {
          fields.push(
            "receipt_image"
          );
          values.push(
            clean(
              body.receipt_image
            )
          );
        }
        if (!fields.length) {
          return json(
            {
              success: false,
              error: "No fields mapped"
            },
            400
          );
        }
        await db.prepare(`
          INSERT INTO expenses
          (${fields.join(",")})
          VALUES
          (${fields.map(() => "?").join(",")})
        `).bind(...values).run();
        return json({
          success: true
        });
      }
      if (path === "/api/stock" && method === "GET") {
        return json({
          success: true,
          stock: await getStock(db)
        });
      }
      if (path === "/api/stock/history" && method === "GET") {
        await ensureSupportTables(
          db
        );
        const limit = Math.min(
          Math.max(
            num(
              url.searchParams.get(
                "limit"
              ) || 100,
              1
            ),
            1
          ),
          500
        );
        const rows = await db.prepare(`
            SELECT
              id,
              stock_item_id,
              item_name,
              old_quantity,
              new_quantity,
              change_quantity,
              action,
              note,
              updated_by,
              created_at
            FROM stock_history
            ORDER BY id DESC
            LIMIT ?
          `).bind(limit).all();
        return json({
          success: true,
          history: rows.results || []
        });
      }
      if (path === "/api/stock" && method === "POST") {
        await ensureSupportTables(
          db
        );
        const body = await request.json();
        const name = clean(
          body.name || body.item
        );
        if (!name) {
          return json(
            {
              success: false,
              error: "Stock item name required"
            },
            400
          );
        }
        const qty = num(
          body.quantity ?? body.qty
        );
        const low = num(
          body.low_stock_level,
          5
        );
        const unit = clean(body.unit) || "pcs";
        const existing = await db.prepare(`
            SELECT
              id,
              quantity
            FROM stock_items
            WHERE lower(name)=lower(?)
            LIMIT 1
          `).bind(name).first();
        const oldQty = num(
          existing?.quantity,
          0
        );
        await db.prepare(`
          INSERT INTO stock_items
          (
            name,
            quantity,
            unit,
            low_stock_level,
            is_active
          )
          VALUES
          (?, ?, ?, ?, 1)
          ON CONFLICT(name)
          DO UPDATE SET
            quantity=excluded.quantity,
            unit=excluded.unit,
            low_stock_level=
              excluded.low_stock_level,
            is_active=1,
            updated_at=
              CURRENT_TIMESTAMP
        `).bind(
          name,
          qty,
          unit,
          low
        ).run();
        const current = await db.prepare(`
            SELECT
              id,
              quantity,
              updated_at
            FROM stock_items
            WHERE lower(name)=lower(?)
            LIMIT 1
          `).bind(name).first();
        const action = existing ? "UPDATE" : "ADD";
        const note = clean(body.note) || (existing ? "Admin stock correction" : "New stock item");
        const updatedBy = clean(
          body.updated_by
        ) || "Admin";
        await db.prepare(`
          INSERT INTO stock_history
          (
            stock_item_id,
            item_name,
            old_quantity,
            new_quantity,
            change_quantity,
            action,
            note,
            updated_by
          )
          VALUES
          (?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          current?.id || null,
          name,
          oldQty,
          qty,
          qty - oldQty,
          action,
          note,
          updatedBy
        ).run();
        return json({
          success: true,
          id: current?.id || null,
          old_quantity: oldQty,
          new_quantity: qty,
          updated_at: current?.updated_at || null
        });
      }
      if (path === "/api/staff" && method === "GET") {
        return json({
          success: true,
          staff: await getStaff(db)
        });
      }
      if (path === "/api/staff" && method === "POST") {
        await ensureSupportTables(
          db
        );
        const body = await request.json();
        const name = clean(body.name);
        if (!name) {
          return json(
            {
              success: false,
              error: "Staff name required"
            },
            400
          );
        }
        const result = await db.prepare(`
            INSERT INTO staff
            (
              name,
              mobile,
              role,
              salary,
              join_date,
              is_active
            )
            VALUES
            (?, ?, ?, ?, ?, ?)
          `).bind(
          name,
          clean(body.mobile),
          clean(body.role),
          num(body.salary),
          clean(
            body.join_date || body.joinDate
          ) || todayIST(),
          bool(
            body.is_active ?? body.active ?? true
          ) ? 1 : 0
        ).run();
        return json({
          success: true,
          id: result.meta?.last_row_id ?? null
        });
      }
      if (path === "/api/staff/update" && method === "POST") {
        await ensureSupportTables(
          db
        );
        const body = await request.json();
        const id = num(body.id);
        if (!id) {
          return json(
            {
              success: false,
              error: "Staff ID is required"
            },
            400
          );
        }
        const fields = [];
        const values = [];
        if (body.name !== void 0) {
          fields.push(
            "name=?"
          );
          values.push(
            clean(body.name)
          );
        }
        if (body.mobile !== void 0) {
          fields.push(
            "mobile=?"
          );
          values.push(
            clean(body.mobile)
          );
        }
        if (body.role !== void 0) {
          fields.push(
            "role=?"
          );
          values.push(
            clean(body.role)
          );
        }
        if (body.salary !== void 0) {
          fields.push(
            "salary=?"
          );
          values.push(
            num(body.salary)
          );
        }
        if (body.join_date !== void 0) {
          fields.push(
            "join_date=?"
          );
          values.push(
            clean(
              body.join_date
            )
          );
        }
        if (body.is_active !== void 0) {
          fields.push(
            "is_active=?"
          );
          values.push(
            bool(
              body.is_active
            ) ? 1 : 0
          );
        }
        if (!fields.length) {
          return json(
            {
              success: false,
              error: "No fields to update"
            },
            400
          );
        }
        fields.push(
          "updated_at=CURRENT_TIMESTAMP"
        );
        await db.prepare(`
          UPDATE staff
          SET ${fields.join(",")}
          WHERE id=?
        `).bind(
          ...values,
          id
        ).run();
        return json({
          success: true
        });
      }
      if (path === "/api/staff/remove" && method === "POST") {
        await ensureSupportTables(db);
        const body = await request.json();
        const id = num(body.id || body.staff_id || body.staffId);
        const requestedBy = clean(body.requested_by || body.requestedBy) || "Admin";
        if (!id) return json({success:false,error:"Staff ID required"},400);

        const existing = await db.prepare(
          `SELECT id, name, is_active FROM staff WHERE id=? LIMIT 1`
        ).bind(id).first();
        if (!existing) return json({success:false,error:"Staff record not found"},404);
        if (Number(existing.is_active) === 0) {
          return json({success:true,already_removed:true,id,name:existing.name,is_active:0});
        }

        const target = `STAFF:${id}`;
        const pending = await db.prepare(`
          SELECT id, order_id, requested_by, reason, status, created_at
          FROM deletion_requests
          WHERE order_id=? AND status='pending'
          ORDER BY id DESC LIMIT 1
        `).bind(target).first();

        if (pending) {
          return json({
            success:true,
            already_pending:true,
            request_id:pending.id,
            order_id:target,
            message:"Staff removal request is already pending approval"
          });
        }

        const result = await db.prepare(`
          INSERT INTO deletion_requests
            (order_id, requested_by, reason, status, created_at)
          VALUES (?, ?, ?, 'pending', CURRENT_TIMESTAMP)
        `).bind(
          target,
          requestedBy,
          `Staff removal: ${clean(existing.name) || "Staff"}`
        ).run();

        return json({
          success:true,
          pending:true,
          request_id:result.meta?.last_row_id ?? result.lastInsertRowid ?? null,
          order_id:target,
          message:"Staff removal request submitted for Admin approval"
        });
      }
      if (path === "/api/staff/status" && method === "POST") {
        await ensureSupportTables(db);
        const body = await request.json();
        const id = num(body.id || body.staff_id || body.staffId);
        if (!id) return json({success:false,error:"Staff ID required"},400);
        const active = bool(body.is_active ?? body.active ?? body.status, true) ? 1 : 0;
        const result = await db.prepare(`UPDATE staff SET is_active=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(active,id).run();
        if (!result.meta || result.meta.changes===0) return json({success:false,error:"Staff record not found"},404);
        return json({success:true,id,is_active:active});
      }
      if (path === "/api/import/full" && method === "POST") {
        const body = await request.json();
        const sales = Array.isArray(body.sales) ? body.sales : (Array.isArray(body.Sales) ? body.Sales : []);
        const menu = Array.isArray(body.menu) ? body.menu : (Array.isArray(body.Menu) ? body.Menu : []);
        const staffRows = Array.isArray(body.staff) ? body.staff : (Array.isArray(body.Staff) ? body.Staff : []);
        const stockRows = Array.isArray(body.stock) ? body.stock : (Array.isArray(body.Stock) ? body.Stock : []);
        const expenseRows = Array.isArray(body.expenses) ? body.expenses : (Array.isArray(body.Expenses) ? body.Expenses : []);

        const parseImportedItems = (value) => {
          if (Array.isArray(value)) return value.map(x => ({
            name: clean(x.name || x.item_name || x.item || x.title),
            qty: num(x.qty ?? x.quantity ?? x.count, 1),
            total: num(x.total ?? x.item_total ?? x.amount, 0),
            price: num(x.price ?? x.unit_price, 0)
          })).filter(x => x.name);
          const text = clean(value).replace(/\[Mode:[^\]]*\]/gi, "").replace(/\[Discount Applied:[^\]]*\]/gi, "").trim();
          if (!text) return [];
          return text.split(/\s*,\s*(?=[^,]+\(x\s*\d+(?:\.\d+)?\))/i).map(part => {
            const m = part.trim().match(/^(.+?)\s*\(x\s*(\d+(?:\.\d+)?)\)\s*(?:₹\s*([\d,.]+))?$/i);
            if (!m) return null;
            const qty = num(m[2], 1);
            const total = num(m[3], 0);
            return { name: clean(m[1]), qty, total, price: qty ? total / qty : 0 };
          }).filter(Boolean);
        };

        const menuCache = new Map();
        const menuRows = await db.prepare(`SELECT id,name,category,price,gst_percent,is_available FROM menu_items`).all();
        for (const m of menuRows.results || []) menuCache.set(clean(m.name).toLowerCase(), m);

        let menuImported = 0;
        for (const row of menu) {
          const name = clean(row.name || row.Name || row.item_name || row["Item Name"] || row.item);
          if (!name) continue;
          const category = clean(row.category || row.Category || row["Menu Category"]) || "Imported";
          const price = num(row.price ?? row.Price ?? row["Base Price"] ?? row.amount, 0);
          const gst = num(row.gst_percent ?? row.GST ?? row["GST %"], 0);
          const key = name.toLowerCase();
          const existing = menuCache.get(key);
          if (existing) {
            await db.prepare(`UPDATE menu_items SET category=?,price=?,gst_percent=?,is_available=1,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(category, price, gst, existing.id).run();
            menuCache.set(key, { ...existing, category, price, gst_percent: gst, is_available: 1 });
          } else {
            const r = await db.prepare(`INSERT INTO menu_items (name,category,price,gst_percent,is_available) VALUES (?,?,?,?,1)`).bind(name, category, price, gst).run();
            const id = r.meta?.last_row_id ?? r.lastInsertRowid;
            menuCache.set(key, { id, name, category, price, gst_percent: gst, is_available: 1 });
          }
          menuImported++;
        }

        let ordersImported = 0, orderItemsImported = 0, ordersSkipped = 0;
        for (const row of sales) {
          const orderNumber = clean(row.order_number || row.orderNumber || row.Order_ID || row.order_id || row["Order ID"] || row["Order_ID"]);
          if (!orderNumber) { ordersSkipped++; continue; }

          let existing = await db.prepare(`SELECT id FROM orders WHERE order_number=? LIMIT 1`).bind(orderNumber).first();
          const itemsValue = row.items || row.Items || row.items_string || row.itemsString || row["Items"] || "";
          const items = parseImportedItems(itemsValue);

          if (existing) {
            const count = await db.prepare(`SELECT COUNT(*) AS count FROM order_items WHERE order_id=?`).bind(existing.id).first();
            if (num(count?.count, 0) > 0) { ordersSkipped++; continue; }
            for (const item of items) {
              const key = item.name.toLowerCase();
              let mi = menuCache.get(key);
              if (!mi) {
                const r = await db.prepare(`INSERT INTO menu_items (name,category,price,gst_percent,is_available) VALUES (?, 'Imported', ?, 0, 1)`).bind(item.name, num(item.price)).run();
                mi = { id: r.meta?.last_row_id ?? r.lastInsertRowid, name:item.name, price:num(item.price), gst_percent:0 };
                menuCache.set(key, mi);
              }
              const qty = num(item.qty, 1);
              const price = item.price > 0 ? item.price : num(mi.price, 0);
              const total = item.total > 0 ? item.total : price * qty;
              await db.prepare(`INSERT INTO order_items (order_id,menu_item_id,item_name,quantity,price,gst_percent,total) VALUES (?,?,?,?,?,?,?)`).bind(existing.id, mi.id, item.name, qty, price, num(mi.gst_percent,0), total).run();
              orderItemsImported++;
            }
            continue;
          }

          const total = num(row.grand_total ?? row.total ?? row.Total_Amount ?? row["Total Amount"] ?? row.amount, 0);
          const discount = num(row.discount ?? row.Discount ?? row["Discount"], 0);
          const payment = clean(row.payment_method || row.paymentMethod || row.Mode || row.mode).replace(/\[Mode:/gi, "").replace(/\]/g, "").trim() || "Cash";
          const table = clean(row.table_number || row.tableNumber || row.Table_Number || row["Table Number"] || row.table) || "Takeaway";
          const date = clean(row.date || row.Date || row.order_date || row["Date"]);
          const time = clean(row.time || row.Time || row.order_time || row["Time"]);
          const created = date ? `${date} ${time}`.trim() : new Date().toISOString();
          const type = table.toLowerCase() === "takeaway" ? "Takeaway" : "Dine-in";

          let r;
          try {
            r = await db.prepare(`INSERT INTO orders (order_number,order_type,customer_name,table_number,subtotal,discount,gst,total,payment_method,payment_status,order_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(orderNumber,type,null,table,Math.max(total + discount,0),discount,0,total,payment,"paid","completed",created,created).run();
          } catch (insertError) {
            if (/unique|constraint/i.test(String(insertError?.message || insertError))) {
              ordersSkipped++;
              continue;
            }
            throw insertError;
          }
          const orderId = r.meta?.last_row_id ?? r.lastInsertRowid;
          if (!orderId) throw new Error(`Order ID was not created for ${orderNumber}`);
          ordersImported++;

          for (const item of items) {
            const key = item.name.toLowerCase();
            let mi = menuCache.get(key);
            if (!mi) {
              const mr = await db.prepare(`INSERT INTO menu_items (name,category,price,gst_percent,is_available) VALUES (?, 'Imported', ?, 0, 1)`).bind(item.name, num(item.price)).run();
              mi = { id: mr.meta?.last_row_id ?? mr.lastInsertRowid, name:item.name, price:num(item.price), gst_percent:0 };
              menuCache.set(key, mi);
            }
            const qty = num(item.qty,1);
            const price = item.price > 0 ? item.price : num(mi.price,0);
            const itemTotal = item.total > 0 ? item.total : price * qty;
            await db.prepare(`INSERT INTO order_items (order_id,menu_item_id,item_name,quantity,price,gst_percent,total) VALUES (?,?,?,?,?,?,?)`).bind(orderId,mi.id,item.name,qty,price,num(mi.gst_percent,0),itemTotal).run();
            orderItemsImported++;
          }
        }

        await ensureSupportTables(db);
        let staffImported = 0;
        for (const row of staffRows) {
          const name = clean(row.name || row.Name || row.Employee || row["Employee Name"]);
          if (!name) continue;
          const mobile = clean(row.mobile || row.Mobile || row.Phone);
          const role = clean(row.role || row.Role || row.Designation) || "Staff";
          const salary = num(row.salary || row.Salary || row["Monthly Salary"],0);
          const joinDate = clean(row.join_date || row.joinDate || row["Join Date"]);
          const existingStaff = await db.prepare(`SELECT id FROM staff WHERE name=? AND mobile=? LIMIT 1`).bind(name,mobile).first();
          if (existingStaff) {
            await db.prepare(`UPDATE staff SET mobile=?,role=?,salary=?,join_date=?,is_active=1,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(mobile,role,salary,joinDate,existingStaff.id).run();
          } else {
            await db.prepare(`INSERT INTO staff (name,mobile,role,salary,join_date,is_active) VALUES (?,?,?,?,?,1)`).bind(name,mobile,role,salary,joinDate).run();
          }
          staffImported++;
        }

        let stockImported = 0;
        for (const row of stockRows) {
          const name = clean(row.name || row.Name || row.item_name || row["Item Name"] || row.item);
          if (!name) continue;
          const quantity = num(row.quantity ?? row.Quantity ?? row.qty ?? row.Qty,0);
          const unit = clean(row.unit || row.Unit) || "pcs";
          const low = num(row.low_stock_level ?? row.lowStockLevel ?? row["Low Stock Level"],5);
          const existingStock = await db.prepare(`SELECT id FROM stock_items WHERE lower(name)=lower(?) LIMIT 1`).bind(name).first();
          if (existingStock) {
            await db.prepare(`UPDATE stock_items SET quantity=?,unit=?,low_stock_level=?,is_active=1,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(quantity,unit,low,existingStock.id).run();
          } else {
            await db.prepare(`INSERT INTO stock_items (name,quantity,unit,low_stock_level,is_active) VALUES (?,?,?,?,1)`).bind(name,quantity,unit,low).run();
          }
          stockImported++;
        }

        let expensesImported = 0;
        for (const row of expenseRows) {
          const category = clean(row.category || row.Category || row["Expense Category"]) || "Other";
          const amount = num(row.amount ?? row.Amount ?? row["Amount (₹)"],0);
          const description = clean(row.description || row.Description || row.note || row.Note);
          const date = clean(row.date || row.Date || row.expense_date) || todayIST();
          await db.prepare(`INSERT INTO expenses (category,amount,description,expense_date) VALUES (?,?,?,?)`).bind(category,amount,description,date).run();
          expensesImported++;
        }

        return json({
          success:true,
          message:"Full import completed successfully",
          imported:{menu:menuImported,orders:ordersImported,order_items:orderItemsImported,staff:staffImported,stock:stockImported,expenses:expensesImported},
          skipped:{orders:ordersSkipped}
        });
      }
      return json(
        {
          success: false,
          error: "API route not found",
          path
        },
        404
      );
    } catch (error) {
      console.error(
        "Viraasat Worker Error:",
        error
      );
      return json(
        {
          success: false,
          error: error?.message || String(error)
        },
        500
      );
    }
  }
};
export {
  worker_default as default
};
//# sourceMappingURL=worker.js.map
