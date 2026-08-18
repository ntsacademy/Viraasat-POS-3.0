// ============================================================
// VIRAASAT POS 3.0
// Cloudflare Worker + D1
// Complete Mobile POS API
// ============================================================

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: JSON_HEADERS
  });
}

function clean(value) {
  return value === undefined || value === null
    ? ""
    : String(value).trim();
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function todayIST() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function makeOrderNumber() {
  return "ORD" + Date.now().toString().slice(-10);
}

// ------------------------------------------------------------
// TABLE / COLUMN HELPERS
// ------------------------------------------------------------

async function tableExists(db, table) {
  const result = await db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
  ).bind(table).first();

  return !!result;
}

async function getColumns(db, table) {
  const result = await db.prepare(
    `PRAGMA table_info(${table})`
  ).all();

  return (result.results || []).map(x => x.name);
}

// ------------------------------------------------------------
// SUPPORT TABLES
// ------------------------------------------------------------

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
}

// ------------------------------------------------------------
// MENU
// ------------------------------------------------------------

async function getMenu(db) {

  const result = await db.prepare(`
    SELECT
      id,
      name,
      category,
      price,
      COALESCE(gst_percent,0) AS gst_percent,
      COALESCE(is_available,1) AS is_available
    FROM menu_items
    ORDER BY category, name
  `).all();

  return result.results || [];
}

// ------------------------------------------------------------
// TABLES
// ------------------------------------------------------------

async function getTables(db) {

  if (!(await tableExists(db, "restaurant_tables"))) {
    return [];
  }

  const cols = await getColumns(db, "restaurant_tables");

  const id =
    cols.includes("id")
      ? "id"
      : "rowid AS id";

  const tableNumber =
    cols.includes("table_number")
      ? "table_number"
      : "'' AS table_number";

  const seating =
    cols.includes("seating_area")
      ? "seating_area"
      : "'' AS seating_area";

  const status =
    cols.includes("status")
      ? "status"
      : "'available' AS status";

  const currentOrder =
    cols.includes("current_order_id")
      ? "current_order_id"
      : "NULL AS current_order_id";

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

// ------------------------------------------------------------
// ORDERS
// ------------------------------------------------------------

async function getOrders(db, limit = 200) {

  if (!(await tableExists(db, "orders"))) {
    return [];
  }

  const cols = await getColumns(db, "orders");

  const pick = (column, fallback) =>
    cols.includes(column)
      ? column
      : fallback;

  const result = await db.prepare(`
    SELECT
      ${pick("id", "rowid AS id")},
      ${pick("order_number", "CAST(id AS TEXT) AS order_number")},
      ${pick("table_number", "NULL AS table_number")},
      ${pick("order_type", "'Takeaway' AS order_type")},
      ${pick("customer_phone", "'' AS customer_phone")},
      ${pick("subtotal", "0 AS subtotal")},
      ${pick("discount", "0 AS discount")},
      ${pick("grand_total",
        cols.includes("total")
          ? "total AS grand_total"
          : "0 AS grand_total"
      )},
      ${pick("payment_method", "'' AS payment_method")},
      ${pick("payment_status", "'' AS payment_status")},
      ${pick("order_status", "'completed' AS order_status")},
      ${pick("items", "'' AS items")},
      ${pick("items_string", "'' AS items_string")},
      ${pick("created_at", "NULL AS created_at")}
    FROM orders
    ORDER BY id DESC
    LIMIT ?
  `).bind(
    Math.min(Math.max(num(limit, 200), 1), 1000)
  ).all();

  const orders = result.results || [];
  if (!orders.length || !(await tableExists(db, "order_items"))) {
    return orders.map(order => ({ ...order, item_details: [] }));
  }

  // IMPORTANT: order_items.menu_item_id is NOT NULL in the live D1 schema.
  // We read item rows directly and attach them to every order so historical
  // orders, Live Sale and Reprint all have the same source of truth.
  const itemCols = await getColumns(db, "order_items");
  const itemIdExpr = itemCols.includes("id") ? "id" : "rowid AS id";
  const orderIdExpr = itemCols.includes("order_id") ? "order_id" : "NULL AS order_id";
  const menuIdExpr = itemCols.includes("menu_item_id") ? "menu_item_id" : "NULL AS menu_item_id";
  const nameExpr = itemCols.includes("item_name")
    ? "item_name AS item_name"
    : itemCols.includes("name")
      ? "name AS item_name"
      : "'' AS item_name";
  const qtyExpr = itemCols.includes("quantity")
    ? "quantity AS quantity"
    : itemCols.includes("qty")
      ? "qty AS quantity"
      : "1 AS quantity";
  const priceExpr = itemCols.includes("price")
    ? "price AS price"
    : itemCols.includes("unit_price")
      ? "unit_price AS price"
      : "0 AS price";
  const totalExpr = itemCols.includes("total") ? "total AS total" : "0 AS total";
  const gstExpr = itemCols.includes("gst_percent") ? "gst_percent AS gst_percent" : "0 AS gst_percent";

  const itemRows = await db.prepare(`
    SELECT ${itemIdExpr}, ${orderIdExpr}, ${menuIdExpr},
           ${nameExpr}, ${qtyExpr}, ${priceExpr}, ${totalExpr}, ${gstExpr}
    FROM order_items
    WHERE order_id IN (${orders.map(() => "?").join(",")})
    ORDER BY id ASC
  `).bind(...orders.map(order => order.id)).all();

  const byOrder = new Map();
  for (const row of (itemRows.results || [])) {
    const key = String(row.order_id);
    if (!byOrder.has(key)) byOrder.set(key, []);
    const qty = num(row.quantity, 1);
    const price = num(row.price, 0);
    const total = num(row.total, price * qty);
    byOrder.get(key).push({
      id: row.id ?? null,
      menu_item_id: row.menu_item_id ?? null,
      name: clean(row.item_name),
      qty,
      quantity: qty,
      price,
      unit_price: price,
      total,
      gst_percent: num(row.gst_percent, 0)
    });
  }

  return orders.map(order => {
    const item_details = byOrder.get(String(order.id)) || [];
    const fallbackItems = item_details.map(item => ({
      name: item.name,
      qty: item.qty,
      price: item.price,
      total: item.total
    }));
    const computedItemsString = item_details
      .map(item => `${item.name} (x${item.qty}) ₹${item.total}`)
      .join(", ");

    return {
      ...order,
      item_details,
      items: item_details.length ? JSON.stringify(fallbackItems) : clean(order.items),
      items_string: item_details.length ? computedItemsString : clean(order.items_string)
    };
  });
}

// ------------------------------------------------------------
// EXPENSES
// ------------------------------------------------------------

async function getExpenses(db, limit = 500) {

  if (!(await tableExists(db, "expenses"))) {
    return [];
  }

  const cols = await getColumns(db, "expenses");

  const pick = (column, fallback) =>
    cols.includes(column)
      ? column
      : fallback;

  const result = await db.prepare(`
    SELECT
      ${pick("id", "rowid AS id")},
      ${pick("category", "'' AS category")},
      ${pick("amount", "0 AS amount")},
      ${pick("description", "'' AS description")},
      ${pick("expense_date", "NULL AS expense_date")},
      ${pick("created_at", "NULL AS created_at")}
    FROM expenses
    ORDER BY id DESC
    LIMIT ?
  `).bind(
    Math.min(Math.max(num(limit, 500), 1), 2000)
  ).all();

  return result.results || [];
}

// ------------------------------------------------------------
// STOCK
// ------------------------------------------------------------

async function getStock(db) {

  await ensureSupportTables(db);

  const result = await db.prepare(`
    SELECT
      id,
      name,
      quantity,
      unit,
      low_stock_level,
      is_active
    FROM stock_items
    WHERE COALESCE(is_active,1)=1
    ORDER BY name
  `).all();

  return result.results || [];
}

// ------------------------------------------------------------
// DASHBOARD
// ------------------------------------------------------------

async function getDashboard(db) {

  const orders = await getOrders(db, 2000);
  const expenses = await getExpenses(db, 2000);
  const tables = await getTables(db);
  const stock = await getStock(db);

  const today = todayIST();

  const validOrders = orders.filter(order =>
    String(order.order_status || "completed").toLowerCase() !== "cancelled"
  );

  const todayOrders = validOrders.filter(order =>
    String(order.created_at || "").slice(0, 10) === today
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
    (sum, expense) => sum + num(expense.amount),
    0
  );

  const averageOrder =
    todayOrders.length
      ? todaySales / todayOrders.length
      : 0;

  const occupiedTables = tables.filter(
    table =>
      String(table.status).toLowerCase() === "occupied"
  ).length;

  let staffSalary = 0;

  if (await tableExists(db, "staff")) {

    const result = await db.prepare(`
      SELECT COALESCE(SUM(salary),0) AS total
      FROM staff
      WHERE COALESCE(is_active,1)=1
    `).first();

    staffSalary = num(result?.total);
  }

  return {
    success: true,

    summary: {
      today_sales: todaySales,
      average_order: averageOrder,
      overall_sales: overallSales,
      total_expenses: totalExpenses,
      staff_payments: staffSalary,
      net_profit: overallSales - totalExpenses
    },

    tables: {
      occupied: occupiedTables,
      available: Math.max(tables.length - occupiedTables, 0),
      total: tables.length
    },

    stock
  };
}

// ------------------------------------------------------------
// TABLE STATUS
// ------------------------------------------------------------

async function updateTable(
  db,
  tableNumber,
  status,
  orderId = null
) {

  if (
    !tableNumber ||
    !(await tableExists(db, "restaurant_tables"))
  ) {
    return;
  }

  const cols = await getColumns(db, "restaurant_tables");

  const updates = [];
  const values = [];

  if (cols.includes("status")) {
    updates.push("status=?");
    values.push(status);
  }

  if (cols.includes("current_order_id")) {
    updates.push("current_order_id=?");
    values.push(orderId);
  }

  if (cols.includes("updated_at")) {
    updates.push("updated_at=CURRENT_TIMESTAMP");
  }

  if (!updates.length) return;

  await db.prepare(`
    UPDATE restaurant_tables
    SET ${updates.join(", ")}
    WHERE CAST(table_number AS TEXT)=?
  `).bind(
    ...values,
    String(tableNumber)
  ).run();
}

// ------------------------------------------------------------
// MENU ITEM RESOLUTION
// ------------------------------------------------------------
// The D1 schema requires order_items.menu_item_id to be NOT NULL.
// Always resolve an item to a real menu_items.id before inserting an order
// item. Historical imports can create a safe menu record when an old Sales
// row contains an item that is no longer present in the Menu sheet.
async function resolveMenuItemId(db, item) {
  const name = clean(item?.name || item?.item_name || item?.Item_Name);
  if (!name) throw new Error("Order item name is required");

  const suppliedId = num(item?.menu_item_id ?? item?.menuItemId ?? item?.id, 0);
  if (suppliedId) {
    const found = await db.prepare("SELECT id FROM menu_items WHERE id=? LIMIT 1").bind(suppliedId).first();
    if (found?.id) return found.id;
  }

  const existing = await db.prepare(
    "SELECT id FROM menu_items WHERE LOWER(TRIM(name))=LOWER(TRIM(?)) LIMIT 1"
  ).bind(name).first();
  if (existing?.id) return existing.id;

  const price = num(item?.price, num(item?.unit_price, 0));
  const gst = num(item?.gst_percent ?? item?.gst, 0);
  const inserted = await db.prepare(`
    INSERT INTO menu_items(name, category, price, gst_percent, is_available)
    VALUES(?, ?, ?, ?, 1)
  `).bind(name, "Imported Sales", price, gst).run();

  const id = inserted.meta?.last_row_id || inserted.lastInsertRowid || null;
  if (!id) throw new Error(`Could not create menu item: ${name}`);
  return id;
}

// ------------------------------------------------------------
// SAVE ORDER
// ------------------------------------------------------------

async function createOrder(db, body) {

  const cols = await getColumns(db, "orders");

  const orderNumber =
    clean(body.order_number || body.orderNumber) ||
    makeOrderNumber();

  const tableNumber =
    clean(body.table_number || body.tableNumber);

  const orderType =
    clean(body.order_type || body.orderType) ||
    (tableNumber ? "Dine-in" : "Takeaway");

  const items =
    Array.isArray(body.items)
      ? body.items
      : [];

  const subtotal = num(
    body.subtotal,
    items.reduce(
      (sum, item) =>
        sum +
        num(
          item.total,
          num(item.price) * num(item.qty, 1)
        ),
      0
    )
  );

  const discount = num(body.discount);

  const grandTotal = num(
    body.grand_total ?? body.total,
    Math.max(subtotal - discount, 0)
  );

  const values = {};

  function add(column, value) {
    if (cols.includes(column)) {
      values[column] = value;
    }
  }

  add("order_number", orderNumber);
  add("table_number", tableNumber || null);
  add("order_type", orderType);
  add("subtotal", subtotal);
  add("discount", discount);
  add("grand_total", grandTotal);
  add("total", grandTotal);
  add(
    "payment_method",
    clean(body.payment_method || body.paymentMethod) || "Cash"
  );
  add("payment_status", body.payment_status || "paid");
  add("order_status", body.order_status || "completed");
  add("items", JSON.stringify(items));
  add(
    "items_string",
    items
      .map(
        item =>
          `${clean(item.name)} x${num(item.qty,1)}`
      )
      .join(", ")
  );
  add("created_at", new Date().toISOString());
  add("updated_at", new Date().toISOString());

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
    ...fields.map(field => values[field])
  ).run();

  const orderId =
    result.meta?.last_row_id ||
    result.lastInsertRowid ||
    null;

  // Save order items
  if (
    orderId &&
    await tableExists(db, "order_items")
  ) {

    const itemCols =
      await getColumns(db, "order_items");

    for (const item of items) {

      const itemValues = {};

      function addItem(column, value) {
        if (itemCols.includes(column)) {
          itemValues[column] = value;
        }
      }

      const resolvedMenuItemId = await resolveMenuItemId(db, item);
      addItem("order_id", orderId);
      addItem("menu_item_id", resolvedMenuItemId);
      addItem("item_name", clean(item.name));
      addItem("name", clean(item.name));
      addItem("quantity", num(item.qty,1));
      addItem("qty", num(item.qty,1));
      addItem("price", num(item.price));
      addItem("unit_price", num(item.price));
      addItem("gst_percent", num(item.gst_percent ?? item.gst, 0));
      addItem(
        "total",
        num(
          item.total,
          num(item.price) * num(item.qty,1)
        )
      );

      const itemFields =
        Object.keys(itemValues);

      if (!itemFields.length) continue;

      await db.prepare(`
        INSERT INTO order_items
        (${itemFields.join(",")})
        VALUES
        (${itemFields.map(() => "?").join(",")})
      `).bind(
        ...itemFields.map(
          field => itemValues[field]
        )
      ).run();
    }
  }

  return {
    orderId,
    orderNumber,
    grandTotal
  };
}

// ------------------------------------------------------------
// MENU IMPORT
// ------------------------------------------------------------

async function importMenu(db, request) {

  const body = await request.json();

  const data =
    Array.isArray(body)
      ? body
      : Array.isArray(body.data)
        ? body.data
        : Array.isArray(body.items)
          ? body.items
          : null;

  if (!Array.isArray(data)) {
    return json({
      success: false,
      error: "Data must be an array"
    }, 400);
  }

  let imported = 0;

  for (const item of data) {

    const name = clean(
      item.Item_Name ??
      item.name ??
      item.Name
    );

    if (!name) continue;

    const category = clean(
      item.Category ??
      item.category
    );

    const price = num(
      item.Price ??
      item.price
    );

    const gst = num(
      item.GST_Percent ??
      item.gst_percent ??
      item.GST
    );

    const available =
      item.Available === undefined
        ? 1
        : /^(no|false|0)$/i.test(
            String(item.Available)
          )
          ? 0
          : 1;

    await db.prepare(`
      INSERT INTO menu_items
      (name, category, price, gst_percent, is_available)
      VALUES (?, ?, ?, ?, ?)
    `).bind(
      name,
      category,
      price,
      gst,
      available
    ).run();

    imported++;
  }

  return json({
    success: true,
    imported
  });
}


// ------------------------------------------------------------
// FULL DATABASE IMPORT
// Accepts one workbook payload with Sales, Menu, Staff, Stock, Expenses.
// The client parses XLSX/CSV and sends normalized JSON here.
// ------------------------------------------------------------
function parseImportNumber(value, fallback = 0) {
  const n = Number(String(value ?? '').replace(/₹/g,'').replace(/,/g,'').replace(/%/g,'').trim());
  return Number.isFinite(n) ? n : fallback;
}

function parseImportItems(raw) {
  const text = clean(raw)
    .replace(/\s*\[(?:Mode|Discount Applied|Address):[^\]]*\]/gi, '')
    .trim();

  if (!text) return [];

  // Parse each comma-separated sales line independently. This is intentionally
  // regex-global rather than split-based so names such as "Bati (Custom)" and
  // other bracket/parenthesis variants cannot break the item boundary.
  const pattern = /([^,]+?)\s*\(x(\d+(?:\.\d+)?)\)(?:\s*₹\s*([\d,]+(?:\.\d+)?))?(?=\s*,|\s*$)/gi;
  const items = [];
  let match;

  while ((match = pattern.exec(text)) !== null) {
    const name = clean(match[1]);
    const qty = parseImportNumber(match[2], 1);
    const rawTotal = match[3];
    const total = rawTotal === undefined || rawTotal === '' ? null : parseImportNumber(rawTotal, null);
    const price = total !== null && qty ? total / qty : 0;

    if (name) {
      items.push({
        name,
        qty,
        price,
        total
      });
    }
  }

  return items;
}

async function hydrateImportedItems(db, items) {
  const output = [];
  for (const item of (Array.isArray(items) ? items : [])) {
    const name = clean(item.name || item.item_name);
    if (!name) continue;
    let price = num(item.price ?? item.unit_price, 0);
    const existing = await db.prepare(
      "SELECT id, price FROM menu_items WHERE LOWER(TRIM(name))=LOWER(TRIM(?)) LIMIT 1"
    ).bind(name).first();
    if (!Number.isFinite(num(item.total, NaN)) && existing) {
      price = num(existing.price, price);
    }
    const qty = num(item.qty ?? item.quantity, 1);
    const total = Number.isFinite(num(item.total, NaN)) ? num(item.total) : qty * price;
    output.push({ name, qty, price, total });
  }
  return output;
}

function normalizeImportDate(dateValue, timeValue) {
  const d = clean(dateValue);
  const t = clean(timeValue) || '12:00 AM';
  if (!d) return new Date().toISOString();

  // YYYY-MM-DD + 12-hour time -> SQLite-friendly local IST timestamp.
  const m = t.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (m) {
    let hour = Number(m[1]);
    const minute = Number(m[2]);
    const ampm = m[3].toUpperCase();
    if (ampm === 'PM' && hour !== 12) hour += 12;
    if (ampm === 'AM' && hour === 12) hour = 0;
    return `${d} ${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}:00`;
  }

  return `${d} ${t}`;
}

async function fullDatabaseImport(db, body) {
  const sales = Array.isArray(body.sales) ? body.sales : [];
  const menu = Array.isArray(body.menu) ? body.menu : [];
  const staff = Array.isArray(body.staff) ? body.staff : [];
  const stock = Array.isArray(body.stock) ? body.stock : [];
  const expenses = Array.isArray(body.expenses) ? body.expenses : [];

  await ensureSupportTables(db);

  const result = {
    success: true,
    sales: { received: sales.length, inserted: 0, skipped: 0, itemsInserted: 0 },
    menu: { received: menu.length, upserted: 0 },
    staff: { received: staff.length, upserted: 0 },
    stock: { received: stock.length, upserted: 0 },
    expenses: { received: expenses.length, inserted: 0 },
    errors: []
  };

  // MENU: upsert by name.
  if (menu.length) {
    for (const row of menu) {
      const name = clean(row.name || row.Name || row.item_name || row.Item_Name);
      if (!name) continue;
      const category = clean(row.category || row.Category || 'Other');
      const price = parseImportNumber(row.price ?? row.Price);
      const gst = parseImportNumber(row.gst_percent ?? row.GST ?? row.GST_Percent);
      const activeRaw = row.active ?? row.Active ?? row.available ?? row.Available ?? 'Yes';
      const active = /^(no|false|inactive|0)$/i.test(String(activeRaw).trim()) ? 0 : 1;

      const existing = await db.prepare(`SELECT id FROM menu_items WHERE LOWER(name)=LOWER(?) LIMIT 1`).bind(name).first();
      if (existing) {
        await db.prepare(`UPDATE menu_items SET category=?, price=?, gst_percent=?, is_available=? WHERE id=?`).bind(category, price, gst, active, existing.id).run();
      } else {
        await db.prepare(`INSERT INTO menu_items(name,category,price,gst_percent,is_available) VALUES(?,?,?,?,?)`).bind(name, category, price, gst, active).run();
      }
      result.menu.upserted++;
    }
  }

  // STOCK: upsert by name.
  if (stock.length) {
    for (const row of stock) {
      const name = clean(row.name || row.Name || row.item || row.Item);
      if (!name) continue;
      await db.prepare(`
        INSERT INTO stock_items(name,quantity,unit,low_stock_level,is_active)
        VALUES(?,?,?,?,1)
        ON CONFLICT(name) DO UPDATE SET
          quantity=excluded.quantity,
          unit=excluded.unit,
          low_stock_level=excluded.low_stock_level,
          is_active=1,
          updated_at=CURRENT_TIMESTAMP
      `).bind(
        name,
        parseImportNumber(row.quantity ?? row.Quantity ?? row.qty),
        clean(row.unit || row.Unit) || 'pcs',
        parseImportNumber(row.low_stock_level ?? row.Low_Stock_Level, 5)
      ).run();
      result.stock.upserted++;
    }
  }

  // STAFF: upsert by mobile where possible; otherwise insert.
  if (staff.length) {
    for (const row of staff) {
      const name = clean(row.name || row.Name);
      if (!name) continue;
      const mobile = clean(row.mobile || row.Mobile || row.phone || row.Phone);
      const role = clean(row.role || row.Role) || 'Staff';
      const salary = parseImportNumber(row.salary ?? row.Monthly_Salary ?? row.monthly_salary);
      const joinDate = clean(row.join_date || row.Date_of_Joining || row.joinDate || row.DOJ) || todayIST();
      const statusRaw = row.status ?? row.Status ?? row.active ?? 'Active';
      const active = /^(inactive|no|false|0)$/i.test(String(statusRaw).trim()) ? 0 : 1;

      let existing = null;
      if (mobile) existing = await db.prepare(`SELECT id FROM staff WHERE mobile=? LIMIT 1`).bind(mobile).first();
      if (existing) {
        await db.prepare(`UPDATE staff SET name=?, role=?, salary=?, join_date=?, is_active=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(name, role, salary, joinDate, active, existing.id).run();
      } else {
        await db.prepare(`INSERT INTO staff(name,mobile,role,salary,join_date,is_active) VALUES(?,?,?,?,?,?)`).bind(name, mobile, role, salary, joinDate, active).run();
      }
      result.staff.upserted++;
    }
  }

  // EXPENSES: insert rows.
  if (expenses.length) {
    for (const row of expenses) {
      const amount = parseImportNumber(row.amount ?? row.Amount);
      if (!amount) continue;
      const category = clean(row.category || row.Category) || 'Other';
      const description = clean(row.description || row.Description || row.note || row.Note);
      const expenseDate = clean(row.date || row.Date || row.expense_date) || todayIST();
      await db.prepare(`INSERT INTO expenses(category,amount,description,expense_date) VALUES(?,?,?,?)`).bind(category, amount, description, expenseDate).run();
      result.expenses.inserted++;
    }
  }

  // SALES: idempotent by order_number. Existing order remains untouched.
  for (const row of sales) {
    try {
      const orderNumber = clean(row.order_id || row.Order_ID || row.order_number || row.Order_Number);
      if (!orderNumber) continue;

      let existing = await db.prepare(`SELECT id FROM orders WHERE order_number=? LIMIT 1`).bind(orderNumber).first();
      let orderId = existing?.id || null;

      if (!orderId) {
        const itemsRaw = row.items || row.Items || row.items_string || row.Items_String || '';
        const rawParsedItems = Array.isArray(row.parsed_items) ? row.parsed_items : parseImportItems(itemsRaw);
        const parsedItems = await hydrateImportedItems(db, rawParsedItems);
        const itemSum = parsedItems.reduce((a,x)=>a+parseImportNumber(x.total),0);
        const discount = parseImportNumber(row.discount ?? row.Discount);
        const total = parseImportNumber(row.total_amount ?? row.Total_Amount ?? row.total ?? row.Total);
        const subtotal = parseImportNumber(row.subtotal ?? row.Subtotal, itemSum || total + discount);
        const paymentMode = clean(row.payment_method || row.Payment_Mode || row.mode || row.Mode) || 'Cash';
        const tableRaw = clean(row.table_number || row.Table_Number || row.table || row.Table);
        const orderType = /takeaway/i.test(tableRaw) ? 'Takeaway' : /delivery/i.test(tableRaw) ? 'Home Delivery' : 'Dine-in';
        const tableNumber = /table\s*/i.test(tableRaw) ? tableRaw.replace(/^table\s*/i,'').trim() : (orderType === 'Dine-in' ? tableRaw : orderType);
        const phone = clean(row.phone || row.Phone || row.customer_phone || row.Customer_Phone) || 'NA';
        const createdAt = normalizeImportDate(row.date || row.Date, row.time || row.Time);

        const orderCols = await getColumns(db, 'orders');
        const orderValues = {};
        const addOrder = (c,v)=>{ if(orderCols.includes(c)) orderValues[c]=v; };
        addOrder('order_number', orderNumber);
        addOrder('order_type', orderType);
        addOrder('table_number', tableNumber || null);
        addOrder('customer_phone', phone);
        addOrder('subtotal', subtotal);
        addOrder('discount', discount);
        addOrder('gst', 0);
        addOrder('total', total);
        addOrder('grand_total', total);
        addOrder('payment_method', paymentMode);
        addOrder('payment_status', 'paid');
        addOrder('order_status', 'completed');
        addOrder('items_string', String(itemsRaw));
        addOrder('items', JSON.stringify(parsedItems));
        addOrder('created_at', createdAt);
        addOrder('updated_at', createdAt);
        const orderFields = Object.keys(orderValues);
        const insert = await db.prepare(`
          INSERT INTO orders(${orderFields.join(',')})
          VALUES(${orderFields.map(()=>'?').join(',')})
        `).bind(...orderFields.map(f=>orderValues[f])).run();

        orderId = insert.meta?.last_row_id || insert.lastInsertRowid || null;
        result.sales.inserted++;
      } else {
        result.sales.skipped++;
      }

      // Only add item rows if this order has no order_items yet.
      if (orderId && await tableExists(db,'order_items')) {
        const itemCount = await db.prepare(`SELECT COUNT(*) AS c FROM order_items WHERE order_id=?`).bind(orderId).first();
        if (!Number(itemCount?.c)) {
          const itemsRaw = row.items || row.Items || row.items_string || row.Items_String || '';
          const rawParsedItems = Array.isArray(row.parsed_items) ? row.parsed_items : parseImportItems(itemsRaw);
          const parsedItems = await hydrateImportedItems(db, rawParsedItems);
          const itemCols = await getColumns(db,'order_items');
          for (const item of parsedItems) {
            const vals = {};
            const add = (c,v)=>{ if(itemCols.includes(c)) vals[c]=v; };
            const resolvedMenuItemId = await resolveMenuItemId(db, item);
            add('order_id',orderId);
            add('menu_item_id',resolvedMenuItemId);
            if(itemCols.includes('item_name')) add('item_name',clean(item.name));
            if(itemCols.includes('name')) add('name',clean(item.name));
            if(itemCols.includes('quantity')) add('quantity',num(item.qty,1));
            if(itemCols.includes('qty')) add('qty',num(item.qty,1));
            if(itemCols.includes('price')) add('price',num(item.price));
            if(itemCols.includes('unit_price')) add('unit_price',num(item.price));
            if(itemCols.includes('gst_percent')) add('gst_percent',0);
            add('total',num(item.total, num(item.price) * num(item.qty,1)));
            const fields=Object.keys(vals);
            if(fields.length){
              await db.prepare(`INSERT INTO order_items(${fields.join(',')}) VALUES(${fields.map(()=>'?').join(',')})`).bind(...fields.map(f=>vals[f])).run();
              result.sales.itemsInserted++;
            }
          }
        }
      }
    } catch (e) {
      result.errors.push({order_id: clean(row.order_id || row.Order_ID), error:e.message});
      if(result.errors.length >= 25) break;
    }
  }

  return result;
}

// ============================================================
// MAIN WORKER
// ============================================================

export default {

  async fetch(request, env) {

    const url = new URL(request.url);

    const path = url.pathname;
    const method = request.method.toUpperCase();

    try {

      const db = env.DB;

      if (!db) {
        return json({
          success: false,
          error: "D1 binding DB is missing"
        }, 500);
      }


      // ------------------------------------------------------
      // FULL DATABASE IMPORT
      // ------------------------------------------------------
      if (
        path === "/api/import/full" &&
        method === "POST"
      ) {
        const body = await request.json();
        return json(await fullDatabaseImport(db, body));
      }

      // ------------------------------------------------------
      // ROOT
      // ------------------------------------------------------

      if (path === "/") {

        return new Response(
          "Viraasat POS API is running",
          {
            headers: {
              "Content-Type":
                "text/plain; charset=utf-8"
            }
          }
        );
      }

      // ------------------------------------------------------
      // DATABASE TEST
      // ------------------------------------------------------

      if (
        path === "/api/test-db" &&
        method === "GET"
      ) {

        const result =
          await db
            .prepare("SELECT 1 AS ok")
            .first();

        return json({
          success: true,
          application: "Viraasat POS 3.0",
          status: "online",
          database: "D1 connected",
          result
        });
      }

      // ------------------------------------------------------
      // DASHBOARD
      // ------------------------------------------------------

      if (
        path === "/api/dashboard" &&
        method === "GET"
      ) {

        await ensureSupportTables(db);

        return json(
          await getDashboard(db)
        );
      }

      // ------------------------------------------------------
      // MENU GET
      // ------------------------------------------------------

      if (
        path === "/api/menu" &&
        method === "GET"
      ) {

        return json({
          success: true,
          items: await getMenu(db)
        });
      }

      // ------------------------------------------------------
      // MENU IMPORT
      // ------------------------------------------------------

      if (
        path === "/api/menu/import" &&
        method === "POST"
      ) {

        return await importMenu(
          db,
          request
        );
      }

      // ------------------------------------------------------
      // MENU ADD
      // ------------------------------------------------------

      if (
        path === "/api/menu" &&
        method === "POST"
      ) {

        const body =
          await request.json();

        const name =
          clean(body.name);

        if (!name) {
          return json({
            success: false,
            error: "Menu name is required"
          }, 400);
        }

        const result =
          await db.prepare(`
            INSERT INTO menu_items
            (name, category, price, gst_percent, is_available)
            VALUES (?, ?, ?, ?, ?)
          `).bind(
            name,
            clean(body.category),
            num(body.price),
            num(body.gst_percent),
            body.is_available === false
              ? 0
              : 1
          ).run();

        return json({
          success: true,
          id: result.meta?.last_row_id || null
        });
      }

      // ------------------------------------------------------
      // TABLES
      // ------------------------------------------------------

      if (
        path === "/api/tables" &&
        method === "GET"
      ) {

        return json({
          success: true,
          tables: await getTables(db)
        });
      }

      // ------------------------------------------------------
      // TABLE ADD
      // ------------------------------------------------------

      if (
        path === "/api/tables" &&
        method === "POST"
      ) {

        const body =
          await request.json();

        const tableNumber =
          clean(
            body.table_number ||
            body.tableNumber
          );

        const seatingArea =
          clean(
            body.seating_area ||
            body.seatingArea
          ) || "Ground Seating";

        if (!tableNumber) {
          return json({
            success: false,
            error: "Table number is required"
          }, 400);
        }

        const cols =
          await getColumns(
            db,
            "restaurant_tables"
          );

        const fields = [];
        const values = [];

        if (cols.includes("table_number")) {
          fields.push("table_number");
          values.push(tableNumber);
        }

        if (cols.includes("seating_area")) {
          fields.push("seating_area");
          values.push(seatingArea);
        }

        if (cols.includes("status")) {
          fields.push("status");
          values.push("available");
        }

        if (cols.includes("current_order_id")) {
          fields.push("current_order_id");
          values.push(null);
        }

        await db.prepare(`
          INSERT INTO restaurant_tables
          (${fields.join(",")})
          VALUES
          (${fields.map(() => "?").join(",")})
        `).bind(...values).run();

        return json({
          success: true
        });
      }

      // ------------------------------------------------------
      // TABLE CLEAR
      // ------------------------------------------------------

      if (
        path === "/api/tables/clear" &&
        method === "POST"
      ) {

        const body =
          await request.json();

        const tableNumber =
          clean(
            body.table_number ||
            body.tableNumber
          );

        await updateTable(
          db,
          tableNumber,
          "available",
          null
        );

        return json({
          success: true
        });
      }

      // ------------------------------------------------------
      // ORDERS GET
      // ------------------------------------------------------

      if (
        path === "/api/orders" &&
        method === "GET"
      ) {

        const limit =
          new URL(request.url)
            .searchParams
            .get("limit") || 200;

        return json({
          success: true,
          orders: await getOrders(
            db,
            limit
          )
        });
      }

      // ------------------------------------------------------
      // CREATE ORDER
      // ------------------------------------------------------

      if (
        path === "/api/orders" &&
        method === "POST"
      ) {

        const body =
          await request.json();

        const result =
          await createOrder(
            db,
            body
          );

        const tableNumber =
          clean(
            body.table_number ||
            body.tableNumber
          );

        if (tableNumber) {

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

      // ------------------------------------------------------
      // CHECKOUT
      // ------------------------------------------------------

      if (
        path === "/api/orders/checkout" &&
        method === "POST"
      ) {

        const body =
          await request.json();

        body.payment_status = "paid";
        body.order_status = "completed";

        const result =
          await createOrder(
            db,
            body
          );

        const tableNumber =
          clean(
            body.table_number ||
            body.tableNumber
          );

        if (tableNumber) {

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

      // ------------------------------------------------------
      // ITEM SALES / TOP SELLING
      // ------------------------------------------------------
      if (path === "/api/item-sales" && method === "GET") {
        if (!(await tableExists(db, "order_items"))) {
          return json({ success: true, items: [], total_item_sales: 0 });
        }
        const itemCols = await getColumns(db, "order_items");
        const nameExpr = itemCols.includes("item_name") ? "item_name" : itemCols.includes("name") ? "name" : "''";
        const qtyExpr = itemCols.includes("quantity") ? "quantity" : itemCols.includes("qty") ? "qty" : "0";
        const totalExpr = itemCols.includes("total") ? "total" : "0";
        const rows = await db.prepare(`
          SELECT COALESCE(NULLIF(TRIM(${nameExpr}),''),'Unknown Item') AS name,
                 COALESCE(${qtyExpr},0) AS quantity,
                 COALESCE(${totalExpr},0) AS total
          FROM order_items
          WHERE order_id IN (SELECT id FROM orders WHERE LOWER(COALESCE(order_status,'completed')) <> 'cancelled')
        `).all();
        const map = new Map();
        let totalUnits = 0;
        let totalValue = 0;
        for (const row of (rows.results || [])) {
          const name = clean(row.name) || 'Unknown Item';
          const quantity = num(row.quantity);
          const total = num(row.total);
          const current = map.get(name) || { name, quantity: 0, total: 0 };
          current.quantity += quantity;
          current.total += total;
          map.set(name, current);
          totalUnits += quantity;
          totalValue += total;
        }
        const items = [...map.values()].sort((a,b) => b.total - a.total || b.quantity - a.quantity).map(item => ({
          ...item,
          sales_percent: totalValue ? (item.total / totalValue) * 100 : 0,
          quantity_percent: totalUnits ? (item.quantity / totalUnits) * 100 : 0
        }));
        return json({ success: true, total_item_sales: totalValue, total_units: totalUnits, items });
      }

      // ------------------------------------------------------
      // EXPENSE GET
      // ------------------------------------------------------

      if (
        path === "/api/expenses" &&
        method === "GET"
      ) {

        return json({
          success: true,
          expenses:
            await getExpenses(db)
        });
      }

      // ------------------------------------------------------
      // EXPENSE ADD
      // ------------------------------------------------------

      if (
        path === "/api/expenses" &&
        method === "POST"
      ) {

        const body =
          await request.json();

        const cols =
          await getColumns(
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
          fields.push("description");
          values.push(
            clean(body.description)
          );
        }

        if (cols.includes("expense_date")) {
          fields.push("expense_date");
          values.push(todayIST());
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

      // ------------------------------------------------------
      // STOCK GET
      // ------------------------------------------------------

      if (
        path === "/api/stock" &&
        method === "GET"
      ) {

        return json({
          success: true,
          stock:
            await getStock(db)
        });
      }

      // ------------------------------------------------------
      // STOCK ADD / UPDATE
      // ------------------------------------------------------

      if (
        path === "/api/stock" &&
        method === "POST"
      ) {

        await ensureSupportTables(db);

        const body =
          await request.json();

        const name =
          clean(
            body.name ||
            body.item
          );

        if (!name) {
          return json({
            success: false,
            error:
              "Stock item name is required"
          }, 400);
        }

        await db.prepare(`
          INSERT INTO stock_items
          (name, quantity, unit, low_stock_level)
          VALUES (?, ?, ?, ?)

          ON CONFLICT(name)
          DO UPDATE SET
            quantity=excluded.quantity,
            unit=excluded.unit,
            low_stock_level=
              excluded.low_stock_level,
            updated_at=
              CURRENT_TIMESTAMP
        `).bind(
          name,
          num(
            body.quantity ??
            body.qty
          ),
          clean(body.unit) || "pcs",
          num(
            body.low_stock_level,
            5
          )
        ).run();

        return json({
          success: true
        });
      }

      // ------------------------------------------------------
      // STAFF GET
      // ------------------------------------------------------

      if (
        path === "/api/staff" &&
        method === "GET"
      ) {

        await ensureSupportTables(db);

        const result =
          await db.prepare(`
            SELECT
              id,
              name,
              mobile,
              role,
              salary,
              join_date,
              is_active
            FROM staff
            ORDER BY name
          `).all();

        return json({
          success: true,
          staff:
            result.results || []
        });
      }

      // ------------------------------------------------------
      // STAFF ADD
      // ------------------------------------------------------

      if (
        path === "/api/staff" &&
        method === "POST"
      ) {

        await ensureSupportTables(db);

        const body =
          await request.json();

        const result =
          await db.prepare(`
            INSERT INTO staff
            (name, mobile, role, salary, join_date)
            VALUES (?, ?, ?, ?, ?)
          `).bind(
            clean(body.name),
            clean(body.mobile),
            clean(body.role),
            num(body.salary),
            clean(
              body.join_date ||
              body.joinDate
            ) || todayIST()
          ).run();

        return json({
          success: true,
          id:
            result.meta?.last_row_id ||
            null
        });
      }

      // ------------------------------------------------------
      // OPTIONS
      // ------------------------------------------------------

      if (method === "OPTIONS") {

        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods":
              "GET,POST,PUT,DELETE,OPTIONS",
            "Access-Control-Allow-Headers":
              "Content-Type, Accept"
          }
        });
      }

      // ------------------------------------------------------
      // NOT FOUND
      // ------------------------------------------------------

      return json({
        success: false,
        error: "API route not found",
        path
      }, 404);

    } catch (error) {

      console.error(
        "Viraasat Worker Error:",
        error
      );

      return json({
        success: false,
        error:
          error?.message ||
          String(error)
      }, 500);
    }
  }
};
