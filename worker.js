// ============================================================
// VIRAASAT POS - ENTERPRISE EDITION
// Cloudflare Worker + D1 Database API
// ============================================================

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept"
};

// ============================================================
// CORE UTILITIES
// ============================================================

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: JSON_HEADERS
  });
}

function clean(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function num(value, fallback = 0) {
  if (typeof value === "string") {
    value = value
      .replace(/₹/g, "")
      .replace(/,/g, "")
      .trim();
  }

  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function bool(value, fallback = true) {
  if (value === undefined || value === null) return fallback;

  const v = String(value).trim().toLowerCase();

  if (
    v === "no" ||
    v === "false" ||
    v === "0" ||
    v === "inactive"
  ) {
    return false;
  }

  return true;
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

function normalizeTime(value) {
  if (!value) return new Date().toISOString();
  return String(value).trim();
}

// ============================================================
// DATABASE HELPERS
// ============================================================

async function tableExists(db, table) {
  const result = await db
    .prepare(
      `SELECT name
       FROM sqlite_master
       WHERE type='table'
       AND name=?`
    )
    .bind(table)
    .first();

  return !!result;
}

async function getColumns(db, table) {
  if (!(await tableExists(db, table))) {
    return [];
  }

  const result = await db
    .prepare(`PRAGMA table_info(${table})`)
    .all();

  return (result.results || []).map(row => row.name);
}

// ============================================================
// SUPPORT TABLES
// ============================================================

async function ensureSupportTables(db) {

  // STOCK
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

  // STOCK HISTORY
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

  // STAFF
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

  // EXPENSES
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

  // ADD RECEIPT IMAGE IF MISSING
  const expCols = await getColumns(db, "expenses");

  if (
    expCols.length > 0 &&
    !expCols.includes("receipt_image")
  ) {
    try {
      await db
        .prepare(
          "ALTER TABLE expenses ADD COLUMN receipt_image TEXT"
        )
        .run();
    } catch (e) {
      console.error(e);
    }
  }

  // DELETION REQUESTS
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
}

// ============================================================
// MENU
// ============================================================

async function getMenu(db) {

  if (!(await tableExists(db, "menu_items"))) {
    return [];
  }

  const cols = await getColumns(db, "menu_items");

  const id =
    cols.includes("id")
      ? "id"
      : "rowid AS id";

  const name =
    cols.includes("name")
      ? "name"
      : "'' AS name";

  const category =
    cols.includes("category")
      ? "category"
      : "'' AS category";

  const price =
    cols.includes("price")
      ? "price"
      : "0 AS price";

  const gst =
    cols.includes("gst_percent")
      ? "COALESCE(gst_percent,0) AS gst_percent"
      : "0 AS gst_percent";

  const active =
    cols.includes("is_available")
      ? "COALESCE(is_available,1) AS is_available"
      : "1 AS is_available";

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

// ============================================================
// TABLES
// ============================================================

async function getTables(db) {

  if (!(await tableExists(db, "restaurant_tables"))) {
    return [];
  }

  const cols = await getColumns(
    db,
    "restaurant_tables"
  );

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

// ============================================================
// ORDER ITEMS MAP
// ============================================================

async function getOrderItemsMap(db, orderIds) {

  const map = {};

  if (
    !orderIds.length ||
    !(await tableExists(db, "order_items"))
  ) {
    return map;
  }

  const cols = await getColumns(
    db,
    "order_items"
  );

  const has = c => cols.includes(c);

  const nameExpr =
    has("item_name")
      ? "item_name"
      : has("name")
        ? "name"
        : "''";

  const qtyExpr =
    has("quantity")
      ? "quantity"
      : has("qty")
        ? "qty"
        : "1";

  const priceExpr =
    has("price")
      ? "price"
      : has("unit_price")
        ? "unit_price"
        : "0";

  const totalExpr =
    has("total")
      ? "total"
      : `(${priceExpr})*(${qtyExpr})`;

  const menuIdExpr =
    has("menu_item_id")
      ? "menu_item_id"
      : "NULL";

  const oidExpr =
    has("order_id")
      ? "order_id"
      : "NULL";

  const qs = orderIds
    .map(() => "?")
    .join(",");

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
  `)
    .bind(...orderIds)
    .all();

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

// ============================================================
// ORDERS GET
// ============================================================

async function getOrders(db, limit = 500) {

  if (!(await tableExists(db, "orders"))) {
    return [];
  }

  const cols = await getColumns(
    db,
    "orders"
  );

  const pick = (
    column,
    fallback
  ) =>
    cols.includes(column)
      ? column
      : fallback;

  const grandTotalExp =
    cols.includes("grand_total")
      ? "grand_total"
      : cols.includes("total")
        ? "total AS grand_total"
        : "0 AS grand_total";

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
  `)
    .bind(
      Math.min(
        Math.max(num(limit, 500), 1),
        5000
      )
    )
    .all();

  const orders = result.results || [];

  const ids = orders
    .map(o => Number(o.id))
    .filter(Number.isFinite);

  const itemMap =
    await getOrderItemsMap(db, ids);

  return orders.map(o => {

    const details =
      itemMap[String(o.id)] || [];

    let items = o.items;
    let itemsString = o.items_string;

    if (details.length) {

      items = JSON.stringify(details);

      if (!itemsString) {
        itemsString = details
          .map(
            i =>
              `${clean(i.name)} (x${num(i.qty, 1)}) ₹${num(i.total)}`
          )
          .join(", ");
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

// ============================================================
// EXPENSES
// ============================================================

async function getExpenses(
  db,
  limit = 1000
) {

  if (!(await tableExists(db, "expenses"))) {
    return [];
  }

  const cols =
    await getColumns(db, "expenses");

  const pick = (
    column,
    fallback
  ) =>
    cols.includes(column)
      ? column
      : fallback;

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
  `)
    .bind(
      Math.min(
        Math.max(num(limit, 1000), 1),
        5000
      )
    )
    .all();

  return result.results || [];
}

// ============================================================
// STOCK
// ============================================================

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

// ============================================================
// STAFF
// ============================================================

async function getStaff(db) {

  await ensureSupportTables(db);

  const result = await db.prepare(`
    SELECT
      id,
      name,
      mobile,
      role,
      salary,
      join_date,
      is_active,
      created_at
    FROM staff
    ORDER BY
      COALESCE(is_active,1) DESC,
      name
  `).all();

  return result.results || [];
}

// ============================================================
// DASHBOARD
// ============================================================

async function getDashboard(db) {

  const [
    orders,
    expenses,
    tables,
    stock,
    staff
  ] = await Promise.all([
    getOrders(db, 5000),
    getExpenses(db, 5000),
    getTables(db),
    getStock(db),
    getStaff(db)
  ]);

  const today = todayIST();

  const validOrders =
    orders.filter(order => {

      const status =
        String(
          order.order_status ||
          "completed"
        ).toLowerCase();

      return (
        status !== "cancelled" &&
        status !== "deleted"
      );
    });

  const todayOrders =
    validOrders.filter(order =>
      String(
        order.created_at || ""
      ).startsWith(today)
    );

  const todaySales =
    todayOrders.reduce(
      (sum, order) =>
        sum + num(order.grand_total),
      0
    );

  const overallSales =
    validOrders.reduce(
      (sum, order) =>
        sum + num(order.grand_total),
      0
    );

  const totalExpenses =
    expenses.reduce(
      (sum, exp) =>
        sum + num(exp.amount),
      0
    );

  const todayExpenses =
    expenses
      .filter(exp =>
        String(
          exp.expense_date ||
          exp.created_at ||
          ""
        ).startsWith(today)
      )
      .reduce(
        (sum, exp) =>
          sum + num(exp.amount),
        0
      );

  const averageOrder =
    todayOrders.length
      ? todaySales / todayOrders.length
      : 0;

  const occupiedTables =
    tables.filter(table =>
      String(
        table.status || ""
      ).toLowerCase() === "occupied"
    ).length;

  const activeStaff =
    staff.filter(
      s => Number(s.is_active) === 1
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
      net_profit:
        overallSales - totalExpenses,
      active_staff: activeStaff
    },

    tables: {
      total: tables.length,
      occupied: occupiedTables,
      available:
        Math.max(
          tables.length -
          occupiedTables,
          0
        )
    },

    stock,
    staff
  };
}

// ============================================================
// TABLE UPDATE
// ============================================================

async function updateTable(
  db,
  tableNumber,
  status,
  orderId = null
) {

  if (
    !tableNumber ||
    !(await tableExists(
      db,
      "restaurant_tables"
    ))
  ) {
    return;
  }

  const cols =
    await getColumns(
      db,
      "restaurant_tables"
    );

  const updates = [];
  const values = [];

  if (cols.includes("status")) {
    updates.push("status=?");
    values.push(status);
  }

  if (
    cols.includes(
      "current_order_id"
    )
  ) {
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
  `)
    .bind(
      ...values,
      String(tableNumber)
    )
    .run();
}

// ============================================================
// ITEMS STRING PARSER
// ============================================================

function parseItemsString(
  itemsString
) {

  if (!itemsString) {
    return [];
  }

  let text =
    String(itemsString)
      .replace(
        /\[Discount Applied:[^\]]+\]/gi,
        ""
      )
      .replace(
        /\[Mode:[^\]]+\]/gi,
        ""
      )
      .trim();

  const parts =
    text
      .split(",")
      .map(x => x.trim())
      .filter(Boolean);

  const items = [];

  for (const part of parts) {

    const match =
      part.match(
        /^(.+?)\s*\(x\s*(\d+(?:\.\d+)?)\)\s*₹\s*([\d,.]+)\s*$/i
      );

    if (!match) {
      continue;
    }

    const name =
      clean(match[1]);

    const quantity =
      num(match[2], 1);

    const total =
      num(match[3]);

    const price =
      quantity > 0
        ? total / quantity
        : total;

    items.push({
      name,
      qty: quantity,
      price,
      total
    });
  }

  return items;
}

// ============================================================
// MENU ITEM ID RESOLVER
// ============================================================

async function resolveMenuItemId(
  db,
  item
) {

  const cols =
    await getColumns(
      db,
      "menu_items"
    );

  if (!cols.length) {
    throw new Error(
      "menu_items table not found"
    );
  }

  // ----------------------------------------------------------
  // 1. USE EXISTING ID IF VALID
  // ----------------------------------------------------------

  const suppliedId =
    num(
      item.id ||
      item.menu_item_id
    );

  if (
    suppliedId &&
    cols.includes("id")
  ) {

    const found =
      await db.prepare(`
        SELECT id, name
        FROM menu_items
        WHERE id=?
        LIMIT 1
      `)
        .bind(suppliedId)
        .first();

    if (found) {
      return Number(found.id);
    }
  }

  // ----------------------------------------------------------
  // 2. FIND BY EXACT ITEM NAME
  // ----------------------------------------------------------

  const itemName =
    clean(
      item.name ||
      item.item_name
    );

  if (!itemName) {
    throw new Error(
      "Menu item name is missing"
    );
  }

  if (cols.includes("name")) {

    const found =
      await db.prepare(`
        SELECT id, name
        FROM menu_items
        WHERE lower(trim(name)) =
              lower(trim(?))
        LIMIT 1
      `)
        .bind(itemName)
        .first();

    if (found) {
      return Number(found.id);
    }
  }

  // ----------------------------------------------------------
  // 3. CREATE MENU ITEM IF NOT FOUND
  // ----------------------------------------------------------

  if (
    cols.includes("id") &&
    cols.includes("name")
  ) {

    const menuFields = [];
    const menuValues = [];

    menuFields.push("name");
    menuValues.push(itemName);

    if (cols.includes("category")) {
      menuFields.push("category");
      menuValues.push(
        clean(item.category) ||
        "Imported"
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
          item.gst_percent ||
          item.gst
        )
      );
    }

    if (cols.includes("is_available")) {
      menuFields.push(
        "is_available"
      );
      menuValues.push(1);
    }

    const result =
      await db.prepare(`
        INSERT INTO menu_items
        (${menuFields.join(",")})
        VALUES
        (${menuFields.map(() => "?").join(",")})
      `)
        .bind(...menuValues)
        .run();

    const newId =
      result.meta?.last_row_id ??
      result.lastInsertRowid ??
      null;

    if (newId) {
      return Number(newId);
    }
  }

  throw new Error(
    `Unable to resolve menu item: ${itemName}`
  );
}

// ============================================================
// CREATE ORDER
// ============================================================

async function createOrder(
  db,
  body
) {

  const cols =
    await getColumns(
      db,
      "orders"
    );

  const orderNumber =
    clean(
      body.order_number ||
      body.orderNumber
    ) ||
    makeOrderNumber();

  // ----------------------------------------------------------
  // DUPLICATE CHECK
  // ----------------------------------------------------------

  if (
    cols.includes("order_number")
  ) {

    const existing =
      await db.prepare(`
        SELECT id, order_number
        FROM orders
        WHERE order_number=?
        LIMIT 1
      `)
        .bind(orderNumber)
        .first();

    if (existing) {

      return {
        orderId: existing.id,
        orderNumber:
          existing.order_number,
        duplicate: true
      };
    }
  }

  const tableNumber =
    clean(
      body.table_number ||
      body.tableNumber
    );

  const orderType =
    clean(
      body.order_type ||
      body.orderType
    ) ||
    (
      tableNumber
        ? "Dine-in"
        : "Takeaway"
    );

  let items =
    Array.isArray(body.items)
      ? body.items
      : [];

  if (
    !items.length &&
    body.items_string
  ) {
    items =
      parseItemsString(
        body.items_string
      );
  }

  // ----------------------------------------------------------
  // RESOLVE MENU IDS
  // ----------------------------------------------------------

  const resolvedItems = [];

  for (const rawItem of items) {

    const item = {
      ...rawItem
    };

    item.name =
      clean(
        item.name ||
        item.item_name
      );

    item.qty =
      num(
        item.qty ??
        item.quantity,
        1
      );

    item.price =
      num(
        item.price ??
        item.unit_price
      );

    item.total =
      num(
        item.total,
        item.price * item.qty
      );

    item.menu_item_id =
      await resolveMenuItemId(
        db,
        item
      );

    item.id =
      item.menu_item_id;

    resolvedItems.push(item);
  }

  items = resolvedItems;

  // ----------------------------------------------------------
  // TOTALS
  // ----------------------------------------------------------

  const subtotal =
    num(
      body.subtotal,
      items.reduce(
        (sum, item) =>
          sum +
          num(
            item.total,
            num(item.price) *
            num(item.qty, 1)
          ),
        0
      )
    );

  const discount =
    num(body.discount);

  const grandTotal =
    num(
      body.grand_total ??
      body.total,
      Math.max(
        subtotal - discount,
        0
      )
    );

  const paymentMethod =
    clean(
      body.payment_method ||
      body.paymentMethod
    ) || "Cash";

  const customerPhone =
    clean(
      body.customer_phone ||
      body.phone
    ) || "NA";

  // ----------------------------------------------------------
  // ORDER VALUES
  // ----------------------------------------------------------

  const values = {};

  const add = (
    column,
    value
  ) => {
    if (cols.includes(column)) {
      values[column] = value;
    }
  };

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
    body.payment_status ||
    "paid"
  );

  add(
    "order_status",
    body.order_status ||
    "completed"
  );

  add(
    "items",
    JSON.stringify(items)
  );

  add(
    "items_string",
    body.items_string ||
    items
      .map(
        item =>
          `${clean(item.name)} (x${num(item.qty, 1)}) ₹${num(item.total, num(item.price) * num(item.qty, 1))}`
      )
      .join(", ")
  );

  add(
    "created_at",
    body.created_at ||
    new Date().toISOString()
  );

  add(
    "updated_at",
    new Date().toISOString()
  );

  const fields =
    Object.keys(values);

  if (!fields.length) {
    throw new Error(
      "orders table structure is incompatible"
    );
  }

  // ----------------------------------------------------------
  // INSERT ORDER
  // ----------------------------------------------------------

  const result =
    await db.prepare(`
      INSERT INTO orders
      (${fields.join(",")})
      VALUES
      (${fields.map(() => "?").join(",")})
    `)
      .bind(
        ...fields.map(
          field =>
            values[field]
        )
      )
      .run();

  const orderId =
    result.meta?.last_row_id ??
    result.lastInsertRowid ??
    null;

  // ----------------------------------------------------------
  // INSERT ORDER ITEMS
  // ----------------------------------------------------------

  if (
    orderId &&
    await tableExists(
      db,
      "order_items"
    )
  ) {

    const itemCols =
      await getColumns(
        db,
        "order_items"
      );

    for (
      const item of items
    ) {

      const itemValues = {};

      const addItem = (
        column,
        value
      ) => {

        if (
          itemCols.includes(
            column
          )
        ) {
          itemValues[column] =
            value;
        }
      };

      addItem(
        "order_id",
        orderId
      );

      // IMPORTANT:
      // Correct menu_item_id
      addItem(
        "menu_item_id",
        item.menu_item_id ||
        item.id ||
        null
      );

      if (
        itemCols.includes(
          "item_name"
        )
      ) {

        addItem(
          "item_name",
          clean(item.name)
        );

      } else if (
        itemCols.includes("name")
      ) {

        addItem(
          "name",
          clean(item.name)
        );
      }

      addItem(
        "quantity",
        num(item.qty, 1)
      );

      if (
        itemCols.includes("qty")
      ) {

        addItem(
          "qty",
          num(item.qty, 1)
        );
      }

      if (
        itemCols.includes("price")
      ) {

        addItem(
          "price",
          num(item.price)
        );
      }

      if (
        itemCols.includes(
          "unit_price"
        )
      ) {

        addItem(
          "unit_price",
          num(item.price)
        );
      }

      if (
        itemCols.includes(
          "gst_percent"
        )
      ) {

        addItem(
          "gst_percent",
          num(
            item.gst_percent ||
            item.gst ||
            0
          )
        );
      }

      addItem(
        "total",
        num(
          item.total,
          num(item.price) *
          num(item.qty, 1)
        )
      );

      const itemFields =
        Object.keys(
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
      `)
        .bind(
          ...itemFields.map(
            field =>
              itemValues[field]
          )
        )
        .run();
    }
  }

  return {
    orderId,
    orderNumber,
    grandTotal,
    duplicate: false
  };
}

// ============================================================
// MAIN WORKER
// ============================================================

export default {

  async fetch(
    request,
    env
  ) {

    const url =
      new URL(request.url);

    const path =
      url.pathname;

    const method =
      request.method.toUpperCase();

    // --------------------------------------------------------
    // CORS
    // --------------------------------------------------------

    if (
      method === "OPTIONS"
    ) {

      return new Response(
        null,
        {
          status: 204,
          headers:
            JSON_HEADERS
        }
      );
    }

    try {

      const db = env.DB;

      if (!db) {

        return json(
          {
            success: false,
            error:
              "D1 Database Binding is missing"
          },
          500
        );
      }

      // ------------------------------------------------------
      // ROOT
      // ------------------------------------------------------

      if (path === "/") {

        return new Response(
          "Viraasat POS Enterprise API Running",
          {
            status: 200
          }
        );
      }

      // ------------------------------------------------------
      // HEALTH
      // ------------------------------------------------------

      if (
        path === "/api/health"
      ) {

        return json({
          success: true,
          application:
            "Viraasat POS Enterprise",
          status: "online",
          database: "connected",
          binding: !!env.DB
        });
      }

      // ------------------------------------------------------
      // DATABASE TEST
      // ------------------------------------------------------

      if (
        path === "/api/test-db"
      ) {

        const check =
          await db
            .prepare(
              "SELECT 1 AS ok"
            )
            .first();

        return json({
          success: true,
          application:
            "Viraasat POS Enterprise",
          database:
            "D1 connected",
          binding: "DB",
          result: check
        });
      }

      // ------------------------------------------------------
      // DASHBOARD
      // ------------------------------------------------------

      if (
        path === "/api/dashboard" &&
        method === "GET"
      ) {

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
          items:
            await getMenu(db)
        });
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

          return json(
            {
              success: false,
              error:
                "Menu name required"
            },
            400
          );
        }

        const cols =
          await getColumns(
            db,
            "menu_items"
          );

        const fields = [];
        const values = [];

        if (
          cols.includes("name")
        ) {

          fields.push("name");
          values.push(name);
        }

        if (
          cols.includes("category")
        ) {

          fields.push("category");
          values.push(
            clean(body.category)
          );
        }

        if (
          cols.includes("price")
        ) {

          fields.push("price");
          values.push(
            num(body.price)
          );
        }

        if (
          cols.includes(
            "gst_percent"
          )
        ) {

          fields.push(
            "gst_percent"
          );

          values.push(
            num(body.gst_percent)
          );
        }

        if (
          cols.includes(
            "is_available"
          )
        ) {

          fields.push(
            "is_available"
          );

          values.push(
            body.is_available === false
              ? 0
              : 1
          );
        }

        const result =
          await db.prepare(`
            INSERT INTO menu_items
            (${fields.join(",")})
            VALUES
            (${fields.map(() => "?").join(",")})
          `)
            .bind(...values)
            .run();

        return json({
          success: true,
          id:
            result.meta?.last_row_id ??
            null
        });
      }

      // ------------------------------------------------------
      // TABLES GET
      // ------------------------------------------------------

      if (
        path === "/api/tables" &&
        method === "GET"
      ) {

        return json({
          success: true,
          tables:
            await getTables(db)
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

        await updateTable(
          db,
          clean(
            body.table_number ||
            body.tableNumber
          ),
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
          url.searchParams.get(
            "limit"
          ) || 500;

        return json({
          success: true,
          orders:
            await getOrders(
              db,
              limit
            )
        });
      }

      // ------------------------------------------------------
      // CREATE ORDER / KOT
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

        if (
          tableNumber &&
          !result.duplicate
        ) {

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
        path ===
          "/api/orders/checkout" &&
        method === "POST"
      ) {

        const body =
          await request.json();

        body.payment_status =
          "paid";

        body.order_status =
          "completed";

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

        if (
          tableNumber &&
          !result.duplicate
        ) {

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
      // ORDER DELETE REQUEST
      // ------------------------------------------------------

      if (
        path ===
          "/api/orders/request-delete" &&
        method === "POST"
      ) {

        await ensureSupportTables(
          db
        );

        const body =
          await request.json();

        const orderId =
          clean(body.order_id);

        const reason =
          clean(body.reason);

        const requestedBy =
          clean(
            body.requested_by
          );

        if (!orderId) {

          return json(
            {
              success: false,
              error:
                "Order ID is required"
            },
            400
          );
        }

        await db.prepare(`
          INSERT INTO deletion_requests
          (
            order_id,
            requested_by,
            reason,
            status
          )
          VALUES
          (?, ?, ?, 'pending')
        `)
          .bind(
            orderId,
            requestedBy,
            reason
          )
          .run();

        const orderCols =
          await getColumns(
            db,
            "orders"
          );

        if (
          orderCols.includes(
            "order_status"
          )
        ) {

          await db.prepare(`
            UPDATE orders
            SET order_status =
              'deletion_pending'
            WHERE
              order_number = ?
              OR id = ?
          `)
            .bind(
              orderId,
              orderId
            )
            .run();
        }

        return json({
          success: true,
          message:
            "Deletion request submitted for approval"
        });
      }

      // ------------------------------------------------------
      // APPROVALS GET
      // ------------------------------------------------------

      if (
        path === "/api/approvals" &&
        method === "GET"
      ) {

        await ensureSupportTables(
          db
        );

        const requests =
          await db.prepare(`
            SELECT *
            FROM deletion_requests
            WHERE status = 'pending'
            ORDER BY id DESC
          `).all();

        return json({
          success: true,
          requests:
            requests.results || []
        });
      }

      // ------------------------------------------------------
      // APPROVAL RESOLVE
      // ------------------------------------------------------

      if (
        path ===
          "/api/approvals/resolve" &&
        method === "POST"
      ) {

        await ensureSupportTables(
          db
        );

        const body =
          await request.json();

        const requestId =
          num(body.request_id);

        const status =
          clean(body.status);

        const orderId =
          clean(body.order_id);

        const reviewedBy =
          clean(
            body.reviewed_by
          );

        if (
          !requestId ||
          !status
        ) {

          return json(
            {
              success: false,
              error:
                "Missing required fields"
            },
            400
          );
        }

        await db.prepare(`
          UPDATE deletion_requests
          SET
            status = ?,
            reviewed_by = ?,
            reviewed_at =
              CURRENT_TIMESTAMP
          WHERE id = ?
        `)
          .bind(
            status,
            reviewedBy,
            requestId
          )
          .run();

        if (
          status === "approved" &&
          orderId
        ) {

          await db.prepare(`
            UPDATE orders
            SET order_status = 'deleted'
            WHERE
              order_number = ?
              OR id = ?
          `)
            .bind(
              orderId,
              orderId
            )
            .run();

        } else if (
          status === "rejected" &&
          orderId
        ) {

          await db.prepare(`
            UPDATE orders
            SET order_status = 'completed'
            WHERE
              order_number = ?
              OR id = ?
          `)
            .bind(
              orderId,
              orderId
            )
            .run();
        }

        return json({
          success: true,
          message:
            `Request ${status}`
        });
      }

      // ------------------------------------------------------
      // EXPENSES GET
      // ------------------------------------------------------

      if (
        path === "/api/expenses" &&
        method === "GET"
      ) {

        const limit =
          Math.min(
            Math.max(
              num(
                url.searchParams.get(
                  "limit"
                ) || 1000,
                1
              ),
              1
            ),
            5000
          );

        return json({
          success: true,
          expenses:
            await getExpenses(
              db,
              limit
            )
        });
      }

      // ------------------------------------------------------
      // EXPENSE ADD
      // ------------------------------------------------------

      if (
        path === "/api/expenses" &&
        method === "POST"
      ) {

        await ensureSupportTables(
          db
        );

        const body =
          await request.json();

        const cols =
          await getColumns(
            db,
            "expenses"
          );

        const fields = [];
        const values = [];

        if (
          cols.includes("category")
        ) {

          fields.push("category");

          values.push(
            clean(body.category)
          );
        }

        if (
          cols.includes("amount")
        ) {

          fields.push("amount");

          values.push(
            num(body.amount)
          );
        }

        if (
          cols.includes("description")
        ) {

          fields.push(
            "description"
          );

          values.push(
            clean(body.description)
          );
        }

        if (
          cols.includes(
            "expense_date"
          )
        ) {

          fields.push(
            "expense_date"
          );

          values.push(
            normalizeDate(
              body.expense_date
            )
          );
        }

        if (
          cols.includes(
            "receipt_image"
          ) &&
          body.receipt_image
        ) {

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
              error:
                "No fields mapped"
            },
            400
          );
        }

        await db.prepare(`
          INSERT INTO expenses
          (${fields.join(",")})
          VALUES
          (${fields.map(() => "?").join(",")})
        `)
          .bind(...values)
          .run();

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
      // STOCK HISTORY
      // ------------------------------------------------------

      if (
        path ===
          "/api/stock/history" &&
        method === "GET"
      ) {

        await ensureSupportTables(
          db
        );

        const limit =
          Math.min(
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

        const rows =
          await db.prepare(`
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
          `)
            .bind(limit)
            .all();

        return json({
          success: true,
          history:
            rows.results || []
        });
      }

      // ------------------------------------------------------
      // STOCK ADD / UPDATE
      // ------------------------------------------------------

      if (
        path === "/api/stock" &&
        method === "POST"
      ) {

        await ensureSupportTables(
          db
        );

        const body =
          await request.json();

        const name =
          clean(
            body.name ||
            body.item
          );

        if (!name) {

          return json(
            {
              success: false,
              error:
                "Stock item name required"
            },
            400
          );
        }

        const qty =
          num(
            body.quantity ??
            body.qty
          );

        const low =
          num(
            body.low_stock_level,
            5
          );

        const unit =
          clean(body.unit) ||
          "pcs";

        const existing =
          await db.prepare(`
            SELECT
              id,
              quantity
            FROM stock_items
            WHERE lower(name)=lower(?)
            LIMIT 1
          `)
            .bind(name)
            .first();

        const oldQty =
          num(
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
        `)
          .bind(
            name,
            qty,
            unit,
            low
          )
          .run();

        const current =
          await db.prepare(`
            SELECT
              id,
              quantity,
              updated_at
            FROM stock_items
            WHERE lower(name)=lower(?)
            LIMIT 1
          `)
            .bind(name)
            .first();

        const action =
          existing
            ? "UPDATE"
            : "ADD";

        const note =
          clean(body.note) ||
          (
            existing
              ? "Admin stock correction"
              : "New stock item"
          );

        const updatedBy =
          clean(
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
        `)
          .bind(
            current?.id || null,
            name,
            oldQty,
            qty,
            qty - oldQty,
            action,
            note,
            updatedBy
          )
          .run();

        return json({
          success: true,
          id:
            current?.id || null,
          old_quantity:
            oldQty,
          new_quantity:
            qty,
          updated_at:
            current?.updated_at ||
            null
        });
      }

      // ------------------------------------------------------
      // STAFF GET
      // ------------------------------------------------------

      if (
        path === "/api/staff" &&
        method === "GET"
      ) {

        return json({
          success: true,
          staff:
            await getStaff(db)
        });
      }

      // ------------------------------------------------------
      // STAFF ADD
      // ------------------------------------------------------

      if (
        path === "/api/staff" &&
        method === "POST"
      ) {

        await ensureSupportTables(
          db
        );

        const body =
          await request.json();

        const name =
          clean(body.name);

        if (!name) {

          return json(
            {
              success: false,
              error:
                "Staff name required"
            },
            400
          );
        }

        const result =
          await db.prepare(`
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
          `)
            .bind(
              name,
              clean(body.mobile),
              clean(body.role),
              num(body.salary),
              clean(
                body.join_date ||
                body.joinDate
              ) || todayIST(),
              bool(
                body.is_active ??
                body.active ??
                true
              )
                ? 1
                : 0
            )
            .run();

        return json({
          success: true,
          id:
            result.meta?.last_row_id ??
            null
        });
      }

      // ------------------------------------------------------
      // STAFF UPDATE
      // ------------------------------------------------------

      if (
        path ===
          "/api/staff/update" &&
        method === "POST"
      ) {

        await ensureSupportTables(
          db
        );

        const body =
          await request.json();

        const id =
          num(body.id);

        if (!id) {

          return json(
            {
              success: false,
              error:
                "Staff ID is required"
            },
            400
          );
        }

        const fields = [];
        const values = [];

        if (
          body.name !== undefined
        ) {

          fields.push(
            "name=?"
          );

          values.push(
            clean(body.name)
          );
        }

        if (
          body.mobile !== undefined
        ) {

          fields.push(
            "mobile=?"
          );

          values.push(
            clean(body.mobile)
          );
        }

        if (
          body.role !== undefined
        ) {

          fields.push(
            "role=?"
          );

          values.push(
            clean(body.role)
          );
        }

        if (
          body.salary !== undefined
        ) {

          fields.push(
            "salary=?"
          );

          values.push(
            num(body.salary)
          );
        }

        if (
          body.join_date !== undefined
        ) {

          fields.push(
            "join_date=?"
          );

          values.push(
            clean(
              body.join_date
            )
          );
        }

        if (
          body.is_active !==
          undefined
        ) {

          fields.push(
            "is_active=?"
          );

          values.push(
            bool(
              body.is_active
            )
              ? 1
              : 0
          );
        }

        if (!fields.length) {

          return json(
            {
              success: false,
              error:
                "No fields to update"
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
        `)
          .bind(
            ...values,
            id
          )
          .run();

        return json({
          success: true
        });
      }

      // ------------------------------------------------------
      // STAFF REMOVE
      // ------------------------------------------------------

      if (
        path ===
          "/api/staff/remove" &&
        method === "POST"
      ) {

        await ensureSupportTables(
          db
        );

        const body =
          await request.json();

        const id =
          num(body.id);

        if (!id) {

          return json(
            {
              success: false,
              error:
                "Staff ID required"
            },
            400
          );
        }

        await db.prepare(`
          UPDATE staff
          SET
            is_active=0,
            updated_at=
              CURRENT_TIMESTAMP
          WHERE id=?
        `)
          .bind(id)
          .run();

        return json({
          success: true,
          removed: true
        });
      }

      // ------------------------------------------------------
      // FULL IMPORT
      // ------------------------------------------------------

      if (
        path ===
          "/api/import/full" &&
        method === "POST"
      ) {

        return json(
          {
            success: false,
            error:
              "Full import should use the dedicated import flow."
          },
          400
        );
      }

      // ------------------------------------------------------
      // NOT FOUND
      // ------------------------------------------------------

      return json(
        {
          success: false,
          error:
            "API route not found",
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
          error:
            error?.message ||
            String(error)
        },
        500
      );
    }
  }
};
