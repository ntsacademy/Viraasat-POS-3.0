// ============================================================
// VIRAASAT POS 3.0
// Cloudflare Worker + D1 Database
// COMPLETE WORKER
// ============================================================

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept"
};

// ============================================================
// BASIC HELPERS
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
  if (value === undefined || value === null) {
    return fallback;
  }

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
  if (!value) {
    return new Date().toISOString();
  }

  const s = String(value).trim();

  if (/^\d{1,2}:\d{2}\s?(AM|PM)$/i.test(s)) {
    return s;
  }

  return s;
}

// ============================================================
// TABLE / COLUMN HELPERS
// ============================================================

async function tableExists(db, table) {
  const result = await db.prepare(
    `SELECT name
     FROM sqlite_master
     WHERE type='table'
     AND name=?`
  ).bind(table).first();

  return !!result;
}

async function getColumns(db, table) {
  if (!(await tableExists(db, table))) {
    return [];
  }

  const result = await db.prepare(
    `PRAGMA table_info(${table})`
  ).all();

  return (result.results || []).map(row => row.name);
}

function pickColumn(columns, preferred, fallback) {
  return columns.includes(preferred)
    ? preferred
    : fallback;
}

// ============================================================
// SUPPORT TABLES
// ============================================================

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
// MENU IMPORT
// ============================================================

async function importMenu(db, data) {

  if (!Array.isArray(data)) {
    throw new Error("Menu data must be an array");
  }

  let imported = 0;
  let updated = 0;
  let skipped = 0;

  const cols = await getColumns(
    db,
    "menu_items"
  );

  for (const item of data) {

    const name = clean(
      item.Name ??
      item.name ??
      item.Item_Name ??
      item.item_name
    );

    if (!name) {
      skipped++;
      continue;
    }

    const category = clean(
      item.Category ??
      item.category
    );

    const price = num(
      item.Price ??
      item.price
    );

    const gst = num(
      item.GST ??
      item.gst ??
      item.GST_Percent ??
      item.gst_percent
    );

    const available = bool(
      item.Active ??
      item.active ??
      item.Available ??
      item.available ??
      item.Is_Available ??
      item.is_available,
      true
    ) ? 1 : 0;

    const existing = await db.prepare(`
      SELECT id
      FROM menu_items
      WHERE LOWER(TRIM(name)) =
            LOWER(TRIM(?))
      LIMIT 1
    `).bind(name).first();

    if (existing) {

      const updates = [];
      const values = [];

      if (cols.includes("category")) {
        updates.push("category=?");
        values.push(category);
      }

      if (cols.includes("price")) {
        updates.push("price=?");
        values.push(price);
      }

      if (cols.includes("gst_percent")) {
        updates.push("gst_percent=?");
        values.push(gst);
      }

      if (cols.includes("is_available")) {
        updates.push("is_available=?");
        values.push(available);
      }

      if (updates.length) {
        await db.prepare(`
          UPDATE menu_items
          SET ${updates.join(",")}
          WHERE id=?
        `).bind(
          ...values,
          existing.id
        ).run();
      }

      updated++;

    } else {

      const fields = [];
      const values = [];

      if (cols.includes("name")) {
        fields.push("name");
        values.push(name);
      }

      if (cols.includes("category")) {
        fields.push("category");
        values.push(category);
      }

      if (cols.includes("price")) {
        fields.push("price");
        values.push(price);
      }

      if (cols.includes("gst_percent")) {
        fields.push("gst_percent");
        values.push(gst);
      }

      if (cols.includes("is_available")) {
        fields.push("is_available");
        values.push(available);
      }

      if (!fields.length) {
        skipped++;
        continue;
      }

      await db.prepare(`
        INSERT INTO menu_items
        (${fields.join(",")})
        VALUES
        (${fields.map(() => "?").join(",")})
      `).bind(...values).run();

      imported++;
    }
  }

  return {
    imported,
    updated,
    skipped
  };
}

// ============================================================
// TABLES
// ============================================================

async function getTables(db) {

  if (!(await tableExists(
    db,
    "restaurant_tables"
  ))) {
    return [];
  }

  const cols =
    await getColumns(
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

  const result =
    await db.prepare(`
      SELECT
        ${id},
        ${tableNumber},
        ${seating},
        ${status},
        ${currentOrder}
      FROM restaurant_tables
      ORDER BY
        CAST(table_number AS INTEGER)
    `).all();

  return result.results || [];
}

// ============================================================
// ORDERS
// ============================================================

async function getOrders(db, limit = 500) {

  if (!(await tableExists(db, "orders"))) {
    return [];
  }

  const cols =
    await getColumns(db, "orders");

  const pick = (column, fallback) =>
    cols.includes(column)
      ? column
      : fallback;

  const grandTotalExpression =
    cols.includes("grand_total")
      ? "grand_total"
      : cols.includes("total")
        ? "total AS grand_total"
        : "0 AS grand_total";

  const result =
    await db.prepare(`
      SELECT
        ${pick("id","rowid AS id")},
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
        ${grandTotalExpression},
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
        Math.max(
          num(limit,500),
          1
        ),
        5000
      )
    ).all();

  return result.results || [];
}

// ============================================================
// EXPENSES
// ============================================================

async function getExpenses(db, limit = 1000) {

  if (!(await tableExists(
    db,
    "expenses"
  ))) {
    return [];
  }

  const cols =
    await getColumns(
      db,
      "expenses"
    );

  const pick = (column, fallback) =>
    cols.includes(column)
      ? column
      : fallback;

  const result =
    await db.prepare(`
      SELECT
        ${pick(
          "id",
          "rowid AS id"
        )},
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
          "created_at",
          "NULL AS created_at"
        )}
      FROM expenses
      ORDER BY id DESC
      LIMIT ?
    `).bind(
      Math.min(
        Math.max(
          num(limit,1000),
          1
        ),
        5000
      )
    ).all();

  return result.results || [];
}

// ============================================================
// STOCK
// ============================================================

async function getStock(db) {

  await ensureSupportTables(db);

  const result =
    await db.prepare(`
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

  const result =
    await db.prepare(`
      SELECT
        id,
        name,
        mobile,
        role,
        salary,
        join_date,
        is_active,
        created_at,
        updated_at
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

  const orders =
    await getOrders(
      db,
      5000
    );

  const expenses =
    await getExpenses(
      db,
      5000
    );

  const tables =
    await getTables(db);

  const stock =
    await getStock(db);

  const staff =
    await getStaff(db);

  const today =
    todayIST();

  const validOrders =
    orders.filter(
      order =>
        String(
          order.order_status ||
          "completed"
        ).toLowerCase() !== "cancelled"
    );

  const todayOrders =
    validOrders.filter(order => {

      const created =
        String(
          order.created_at || ""
        );

      return created.startsWith(today);
    });

  const todaySales =
    todayOrders.reduce(
      (sum, order) =>
        sum +
        num(
          order.grand_total
        ),
      0
    );

  const overallSales =
    validOrders.reduce(
      (sum, order) =>
        sum +
        num(
          order.grand_total
        ),
      0
    );

  const totalExpenses =
    expenses.reduce(
      (sum, expense) =>
        sum +
        num(expense.amount),
      0
    );

  const todayExpenses =
    expenses.filter(
      expense =>
        String(
          expense.expense_date ||
          expense.created_at ||
          ""
        ).startsWith(today)
    ).reduce(
      (sum, expense) =>
        sum +
        num(expense.amount),
      0
    );

  const averageOrder =
    todayOrders.length
      ? todaySales /
        todayOrders.length
      : 0;

  const occupiedTables =
    tables.filter(
      table =>
        String(
          table.status || ""
        ).toLowerCase() ===
        "occupied"
    ).length;

  const activeStaff =
    staff.filter(
      s =>
        Number(
          s.is_active
        ) === 1
    ).length;

  return {
    success: true,

    summary: {
      today_sales:
        todaySales,

      today_orders:
        todayOrders.length,

      average_order:
        averageOrder,

      overall_sales:
        overallSales,

      total_expenses:
        totalExpenses,

      today_expenses:
        todayExpenses,

      net_profit:
        overallSales -
        totalExpenses,

      active_staff:
        activeStaff
    },

    tables: {
      total:
        tables.length,

      occupied:
        occupiedTables,

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

  if (
    cols.includes("updated_at")
  ) {
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
    WHERE
      CAST(table_number AS TEXT)=?
  `).bind(
    ...values,
    String(tableNumber)
  ).run();
}

// ============================================================
// PARSE SALES ITEM STRING
// ============================================================

function parseItemsString(itemsString) {

  if (!itemsString) {
    return [];
  }

  let text =
    String(itemsString);

  text =
    text
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
      num(match[2],1);

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

  // Duplicate protection
  if (
    cols.includes("order_number")
  ) {

    const existing =
      await db.prepare(`
        SELECT id, order_number
        FROM orders
        WHERE order_number=?
        LIMIT 1
      `).bind(
        orderNumber
      ).first();

    if (existing) {

      return {
        orderId:
          existing.id,

        orderNumber:
          existing.order_number,

        duplicate:
          true
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
    Array.isArray(
      body.items
    )
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

  const subtotal =
    num(
      body.subtotal,
      items.reduce(
        (sum,item) =>
          sum +
          num(
            item.total,
            num(item.price) *
            num(item.qty,1)
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
        subtotal -
        discount,
        0
      )
    );

  const paymentMethod =
    clean(
      body.payment_method ||
      body.paymentMethod
    ) ||
    "Cash";

  const customerPhone =
    clean(
      body.customer_phone ||
      body.phone
    ) ||
    "NA";

  const values = {};

  function add(
    column,
    value
  ) {
    if (
      cols.includes(column)
    ) {
      values[column] =
        value;
    }
  }

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
    items.map(item =>
      `${clean(item.name)} (x${num(item.qty,1)}) ₹${num(item.total,num(item.price)*num(item.qty,1))}`
    ).join(", ")
  );

  const createdAt =
    body.created_at ||
    new Date().toISOString();

  add(
    "created_at",
    createdAt
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

  const result =
    await db.prepare(`
      INSERT INTO orders
      (${fields.join(",")})
      VALUES
      (${fields.map(() => "?").join(",")})
    `).bind(
      ...fields.map(
        field =>
          values[field]
      )
    ).run();

  const orderId =
    result.meta?.last_row_id ??
    result.lastInsertRowid ??
    null;

  // ==========================================================
  // ORDER ITEMS
  // ==========================================================

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

      function addItem(
        column,
        value
      ) {
        if (
          itemCols.includes(
            column
          )
        ) {
          itemValues[column] =
            value;
        }
      }

      addItem(
        "order_id",
        orderId
      );

      addItem(
        "menu_item_id",
        item.id ||
        item.menu_item_id ||
        null
      );

      // IMPORTANT
      // Your D1 database uses item_name
      if (
        itemCols.includes(
          "item_name"
        )
      ) {
        addItem(
          "item_name",
          clean(item.name)
        );
      }
      else if (
        itemCols.includes(
          "name"
        )
      ) {
        addItem(
          "name",
          clean(item.name)
        );
      }

      addItem(
        "quantity",
        num(item.qty,1)
      );

      if (
        itemCols.includes("qty")
      ) {
        addItem(
          "qty",
          num(item.qty,1)
        );
      }

      if (
        itemCols.includes(
          "price"
        )
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
          num(item.qty,1)
        )
      );

      const itemFields =
        Object.keys(
          itemValues
        );

      if (
        !itemFields.length
      ) {
        continue;
      }

      await db.prepare(`
        INSERT INTO order_items
        (${itemFields.join(",")})
        VALUES
        (${itemFields.map(() => "?").join(",")})
      `).bind(
        ...itemFields.map(
          field =>
            itemValues[field]
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

// ============================================================
// FULL DATABASE IMPORT
//
// Expected body:
//
// {
//   "sales": [...],
//   "menu": [...],
//   "staff": [...],
//   "stock": [...],
//   "expenses": [...]
// }
//
// Sales columns supported:
//
// Date
// Time
// Order_ID
// Phone
// Items
// Total_Amount
// Table_Number
// Discount
// Payment_Mode
// ============================================================

async function fullDatabaseImport(
  db,
  body
) {

  await ensureSupportTables(db);

  const sales =
    Array.isArray(body.sales)
      ? body.sales
      : [];

  const menu =
    Array.isArray(body.menu)
      ? body.menu
      : [];

  const staff =
    Array.isArray(body.staff)
      ? body.staff
      : [];

  const stock =
    Array.isArray(body.stock)
      ? body.stock
      : [];

  const expenses =
    Array.isArray(body.expenses)
      ? body.expenses
      : [];

  const result = {
    sales: {
      inserted: 0,
      duplicate: 0,
      failed: 0
    },

    order_items: {
      inserted: 0
    },

    menu: {
      inserted: 0,
      updated: 0,
      skipped: 0
    },

    staff: {
      inserted: 0,
      updated: 0,
      skipped: 0
    },

    stock: {
      inserted: 0,
      updated: 0,
      skipped: 0
    },

    expenses: {
      inserted: 0,
      skipped: 0
    }
  };

  // ==========================================================
  // MENU
  // ==========================================================

  if (menu.length) {

    result.menu =
      await importMenu(
        db,
        menu
      );
  }

  // ==========================================================
  // STAFF
  // ==========================================================

  for (
    const person of staff
  ) {

    const name =
      clean(
        person.Name ??
        person.name
      );

    if (!name) {
      result.staff.skipped++;
      continue;
    }

    const mobile =
      clean(
        person.Mobile ??
        person.mobile
      );

    const role =
      clean(
        person.Role ??
        person.role
      );

    const salary =
      num(
        person.Monthly_Salary ??
        person.salary ??
        person.Salary
      );

    const joinDate =
      clean(
        person.Date_of_Joining ??
        person.join_date ??
        person.joinDate
      ) ||
      todayIST();

    const active =
      bool(
        person.Status ??
        person.status ??
        person.Active ??
        person.active,
        true
      )
        ? 1
        : 0;

    const existing =
      await db.prepare(`
        SELECT id
        FROM staff
        WHERE
          (
            mobile=?
            AND mobile<>''
          )
          OR
          LOWER(TRIM(name))=
          LOWER(TRIM(?))
        LIMIT 1
      `).bind(
        mobile,
        name
      ).first();

    if (existing) {

      await db.prepare(`
        UPDATE staff
        SET
          name=?,
          mobile=?,
          role=?,
          salary=?,
          join_date=?,
          is_active=?,
          updated_at=CURRENT_TIMESTAMP
        WHERE id=?
      `).bind(
        name,
        mobile,
        role,
        salary,
        joinDate,
        active,
        existing.id
      ).run();

      result.staff.updated++;

    } else {

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
        (?,?,?,?,?,?)
      `).bind(
        name,
        mobile,
        role,
        salary,
        joinDate,
        active
      ).run();

      result.staff.inserted++;
    }
  }

  // ==========================================================
  // STOCK
  // ==========================================================

  for (
    const item of stock
  ) {

    const name =
      clean(
        item.Name ??
        item.name
      );

    if (!name) {
      result.stock.skipped++;
      continue;
    }

    const quantity =
      num(
        item.Quantity ??
        item.quantity ??
        item.Qty ??
        item.qty
      );

    const unit =
      clean(
        item.Unit ??
        item.unit
      ) ||
      "pcs";

    const lowStock =
      num(
        item.Low_Stock_Level ??
        item.low_stock_level ??
        item.LowStock
      ,5);

    const existing =
      await db.prepare(`
        SELECT id
        FROM stock_items
        WHERE
          LOWER(TRIM(name))=
          LOWER(TRIM(?))
        LIMIT 1
      `).bind(name).first();

    if (existing) {

      await db.prepare(`
        UPDATE stock_items
        SET
          quantity=?,
          unit=?,
          low_stock_level=?,
          is_active=1,
          updated_at=CURRENT_TIMESTAMP
        WHERE id=?
      `).bind(
        quantity,
        unit,
        lowStock,
        existing.id
      ).run();

      result.stock.updated++;

    } else {

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
        (?,?,?,?,1)
      `).bind(
        name,
        quantity,
        unit,
        lowStock
      ).run();

      result.stock.inserted++;
    }
  }

  // ==========================================================
  // EXPENSES
  // ==========================================================

  if (
    expenses.length &&
    await tableExists(
      db,
      "expenses"
    )
  ) {

    const expenseCols =
      await getColumns(
        db,
        "expenses"
      );

    for (
      const expense of expenses
    ) {

      const amount =
        num(
          expense.Amount ??
          expense.amount
        );

      if (
        !amount &&
        !expense.Description &&
        !expense.description
      ) {
        result.expenses.skipped++;
        continue;
      }

      const category =
        clean(
          expense.Category ??
          expense.category
        );

      const description =
        clean(
          expense.Description ??
          expense.description
        );

      const date =
        normalizeDate(
          expense.Date ??
          expense.date ??
          expense.expense_date
        );

      const fields = [];
      const values = [];

      if (
        expenseCols.includes(
          "category"
        )
      ) {
        fields.push("category");
        values.push(category);
      }

      if (
        expenseCols.includes(
          "amount"
        )
      ) {
        fields.push("amount");
        values.push(amount);
      }

      if (
        expenseCols.includes(
          "description"
        )
      ) {
        fields.push("description");
        values.push(description);
      }

      if (
        expenseCols.includes(
          "expense_date"
        )
      ) {
        fields.push("expense_date");
        values.push(date);
      }

      if (!fields.length) {
        result.expenses.skipped++;
        continue;
      }

      await db.prepare(`
        INSERT INTO expenses
        (${fields.join(",")})
        VALUES
        (${fields.map(() => "?").join(",")})
      `).bind(...values).run();

      result.expenses.inserted++;
    }
  }

  // ==========================================================
  // SALES / ORDERS
  // ==========================================================

  for (
    const sale of sales
  ) {

    try {

      const orderNumber =
        clean(
          sale.Order_ID ??
          sale.order_id ??
          sale.orderNumber ??
          sale.order_number
        );

      if (!orderNumber) {
        result.sales.failed++;
        continue;
      }

      // -----------------------------------------------
      // DUPLICATE CHECK
      // -----------------------------------------------

      const existing =
        await db.prepare(`
          SELECT id
          FROM orders
          WHERE order_number=?
          LIMIT 1
        `).bind(
          orderNumber
        ).first();

      if (existing) {

        result.sales.duplicate++;
        continue;
      }

      // -----------------------------------------------
      // BASIC VALUES
      // -----------------------------------------------

      const date =
        normalizeDate(
          sale.Date ??
          sale.date
        );

      const time =
        normalizeTime(
          sale.Time ??
          sale.time
        );

      const phone =
        clean(
          sale.Phone ??
          sale.phone
        ) ||
        "NA";

      const table =
        clean(
          sale.Table_Number ??
          sale.table_number ??
          sale.table
        );

      const discount =
        num(
          sale.Discount ??
          sale.discount
        );

      const total =
        num(
          sale.Total_Amount ??
          sale.total_amount ??
          sale.total ??
          sale.grand_total
        );

      const payment =
        clean(
          sale.Payment_Mode ??
          sale.payment_mode ??
          sale.paymentMethod ??
          sale.payment_method
        );

      const rawItems =
        clean(
          sale.Items ??
          sale.items ??
          sale.items_string
        );

      const parsedItems =
        parseItemsString(
          rawItems
        );

      const calculatedSubtotal =
        parsedItems.reduce(
          (sum,item) =>
            sum +
            num(item.total),
          0
        );

      const subtotal =
        calculatedSubtotal ||
        Math.max(
          total +
          discount,
          0
        );

      let orderType =
        "Takeaway";

      if (
        /^table\s*/i.test(table)
      ) {
        orderType =
          "Dine-in";
      }

      // -----------------------------------------------
      // CREATED AT
      // -----------------------------------------------

      let createdAt =
        `${date} ${time}`;

      if (
        /^\d{1,2}:\d{2}\s?(AM|PM)$/i.test(
          time
        )
      ) {

        const m =
          time.match(
            /^(\d{1,2}):(\d{2})\s?(AM|PM)$/i
          );

        if (m) {

          let hour =
            Number(m[1]);

          const minute =
            m[2];

          const ampm =
            m[3].toUpperCase();

          if (
            ampm === "PM" &&
            hour !== 12
          ) {
            hour += 12;
          }

          if (
            ampm === "AM" &&
            hour === 12
          ) {
            hour = 0;
          }

          createdAt =
            `${date} ${String(hour).padStart(2,"0")}:${minute}:00`;
        }
      }

      // -----------------------------------------------
      // INSERT ORDER
      // -----------------------------------------------

      const orderCols =
        await getColumns(
          db,
          "orders"
        );

      const values = {};

      function addOrder(
        column,
        value
      ) {
        if (
          orderCols.includes(
            column
          )
        ) {
          values[column] =
            value;
        }
      }

      addOrder(
        "order_number",
        orderNumber
      );

      addOrder(
        "order_type",
        orderType
      );

      addOrder(
        "table_number",
        table || null
      );

      addOrder(
        "customer_phone",
        phone
      );

      addOrder(
        "subtotal",
        subtotal
      );

      addOrder(
        "discount",
        discount
      );

      addOrder(
        "gst",
        0
      );

      addOrder(
        "grand_total",
        total
      );

      addOrder(
        "total",
        total
      );

      addOrder(
        "payment_method",
        payment || "Cash"
      );

      addOrder(
        "payment_status",
        "paid"
      );

      addOrder(
        "order_status",
        "completed"
      );

      addOrder(
        "items_string",
        rawItems
      );

      addOrder(
        "items",
        JSON.stringify(
          parsedItems
        )
      );

      addOrder(
        "created_at",
        createdAt
      );

      addOrder(
        "updated_at",
        createdAt
      );

      const fields =
        Object.keys(values);

      const insert =
        await db.prepare(`
          INSERT INTO orders
          (${fields.join(",")})
          VALUES
          (${fields.map(() => "?").join(",")})
        `).bind(
          ...fields.map(
            field =>
              values[field]
          )
        ).run();

      const orderId =
        insert.meta?.last_row_id ??
        insert.lastInsertRowid ??
        null;

      result.sales.inserted++;

      // -----------------------------------------------
      // INSERT ORDER ITEMS
      // -----------------------------------------------

      if (
        orderId &&
        parsedItems.length &&
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
          const item of parsedItems
        ) {

          const itemValues = {};

          function addItem(
            column,
            value
          ) {
            if (
              itemCols.includes(
                column
              )
            ) {
              itemValues[column] =
                value;
            }
          }

          addItem(
            "order_id",
            orderId
          );

          // Existing DB uses item_name
          if (
            itemCols.includes(
              "item_name"
            )
          ) {
            addItem(
              "item_name",
              item.name
            );
          }
          else if (
            itemCols.includes(
              "name"
            )
          ) {
            addItem(
              "name",
              item.name
            );
          }

          addItem(
            "quantity",
            item.qty
          );

          if (
            itemCols.includes(
              "qty"
            )
          ) {
            addItem(
              "qty",
              item.qty
            );
          }

          if (
            itemCols.includes(
              "price"
            )
          ) {
            addItem(
              "price",
              item.price
            );
          }

          if (
            itemCols.includes(
              "unit_price"
            )
          ) {
            addItem(
              "unit_price",
              item.price
            );
          }

          addItem(
            "total",
            item.total
          );

          const itemFields =
            Object.keys(
              itemValues
            );

          if (
            !itemFields.length
          ) {
            continue;
          }

          await db.prepare(`
            INSERT INTO order_items
            (${itemFields.join(",")})
            VALUES
            (${itemFields.map(() => "?").join(",")})
          `).bind(
            ...itemFields.map(
              field =>
                itemValues[field]
            )
          ).run();

          result.order_items.inserted++;
        }
      }

    } catch (error) {

      console.error(
        "Import sales row error:",
        error
      );

      result.sales.failed++;
    }
  }

  return result;
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
      new URL(
        request.url
      );

    const path =
      url.pathname;

    const method =
      request.method.toUpperCase();

    // --------------------------------------------------------
    // OPTIONS
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

      const db =
        env.DB;

      if (!db) {

        return json({
          success: false,
          error:
            "D1 binding DB is missing"
        },500);
      }

      // ======================================================
      // ROOT
      // ======================================================

      if (
        path === "/"
      ) {

        return new Response(
          "Viraasat POS API is running",
          {
            status: 200,
            headers: {
              "Content-Type":
                "text/plain; charset=utf-8"
            }
          }
        );
      }

      // ======================================================
      // TEST DB
      // ======================================================

      if (
        path === "/api/test-db"
      ) {

        const result =
          await db
            .prepare(
              "SELECT 1 AS ok"
            )
            .first();

        return json({
          success: true,
          database:
            "D1 connected",
          result
        });
      }

      // ======================================================
      // HEALTH
      // ======================================================

      if (
        path === "/api/health"
      ) {

        return json({
          success: true,
          application:
            "Viraasat POS",
          status:
            "online",
          database:
            "D1 connected"
        });
      }

      // ======================================================
      // DASHBOARD
      // ======================================================

      if (
        path === "/api/dashboard" &&
        method === "GET"
      ) {

        return json(
          await getDashboard(
            db
          )
        );
      }

      // ======================================================
      // MENU GET
      // ======================================================

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

      // ======================================================
      // MENU IMPORT
      // ======================================================

      if (
        path === "/api/menu/import" &&
        method === "POST"
      ) {

        const body =
          await request.json();

        const data =
          Array.isArray(body)
            ? body
            : Array.isArray(
                body.data
              )
              ? body.data
              : Array.isArray(
                  body.items
                )
                ? body.items
                : [];

        const result =
          await importMenu(
            db,
            data
          );

        return json({
          success: true,
          ...result
        });
      }

      // ======================================================
      // MENU ADD
      // ======================================================

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
            error:
              "Menu name is required"
          },400);
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
          cols.includes(
            "category"
          )
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
            body.is_available ===
            false
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
          `).bind(
            ...values
          ).run();

        return json({
          success: true,
          id:
            result.meta?.last_row_id ??
            null
        });
      }

      // ======================================================
      // TABLES GET
      // ======================================================

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

      // ======================================================
      // TABLE ADD
      // ======================================================

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
          ) ||
          "Ground Seating";

        if (!tableNumber) {

          return json({
            success: false,
            error:
              "Table number is required"
          },400);
        }

        const cols =
          await getColumns(
            db,
            "restaurant_tables"
          );

        const fields = [];
        const values = [];

        if (
          cols.includes(
            "table_number"
          )
        ) {
          fields.push(
            "table_number"
          );
          values.push(
            tableNumber
          );
        }

        if (
          cols.includes(
            "seating_area"
          )
        ) {
          fields.push(
            "seating_area"
          );
          values.push(
            seatingArea
          );
        }

        if (
          cols.includes("status")
        ) {
          fields.push(
            "status"
          );
          values.push(
            "available"
          );
        }

        if (
          cols.includes(
            "current_order_id"
          )
        ) {
          fields.push(
            "current_order_id"
          );
          values.push(null);
        }

        await db.prepare(`
          INSERT INTO restaurant_tables
          (${fields.join(",")})
          VALUES
          (${fields.map(() => "?").join(",")})
        `).bind(
          ...values
        ).run();

        return json({
          success: true
        });
      }

      // ======================================================
      // TABLE CLEAR
      // ======================================================

      if (
        path ===
          "/api/tables/clear" &&
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

      // ======================================================
      // ORDERS GET
      // ======================================================

      if (
        path === "/api/orders" &&
        method === "GET"
      ) {

        const limit =
          new URL(
            request.url
          )
            .searchParams
            .get("limit") ||
          500;

        return json({
          success: true,
          orders:
            await getOrders(
              db,
              limit
            )
        });
      }

      // ======================================================
      // CREATE ORDER
      // ======================================================

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

      // ======================================================
      // CHECKOUT
      // ======================================================

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

      // ======================================================
      // EXPENSE GET
      // ======================================================

      if (
        path ===
          "/api/expenses" &&
        method === "GET"
      ) {

        return json({
          success: true,
          expenses:
            await getExpenses(
              db
            )
        });
      }

      // ======================================================
      // EXPENSE ADD
      // ======================================================

      if (
        path ===
          "/api/expenses" &&
        method === "POST"
      ) {

        const body =
          await request.json();

        if (
          !(await tableExists(
            db,
            "expenses"
          ))
        ) {

          return json({
            success: false,
            error:
              "expenses table not found"
          },500);
        }

        const cols =
          await getColumns(
            db,
            "expenses"
          );

        const fields = [];
        const values = [];

        if (
          cols.includes(
            "category"
          )
        ) {
          fields.push(
            "category"
          );
          values.push(
            clean(
              body.category
            )
          );
        }

        if (
          cols.includes(
            "amount"
          )
        ) {
          fields.push(
            "amount"
          );
          values.push(
            num(
              body.amount
            )
          );
        }

        if (
          cols.includes(
            "description"
          )
        ) {
          fields.push(
            "description"
          );
          values.push(
            clean(
              body.description
            )
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

        await db.prepare(`
          INSERT INTO expenses
          (${fields.join(",")})
          VALUES
          (${fields.map(() => "?").join(",")})
        `).bind(
          ...values
        ).run();

        return json({
          success: true
        });
      }

      // ======================================================
      // STOCK GET
      // ======================================================

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

      // ======================================================
      // STOCK ADD / UPDATE
      // ======================================================

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

          return json({
            success: false,
            error:
              "Stock item name is required"
          },400);
        }

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
            quantity=
              excluded.quantity,
            unit=
              excluded.unit,
            low_stock_level=
              excluded.low_stock_level,
            is_active=1,
            updated_at=
              CURRENT_TIMESTAMP
        `).bind(
          name,
          num(
            body.quantity ??
            body.qty
          ),
          clean(
            body.unit
          ) || "pcs",
          num(
            body.low_stock_level,
            5
          )
        ).run();

        return json({
          success: true
        });
      }

      // ======================================================
      // STAFF GET
      // ======================================================

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

      // ======================================================
      // STAFF ADD
      // ======================================================

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
          clean(
            body.name
          );

        if (!name) {

          return json({
            success: false,
            error:
              "Staff name is required"
          },400);
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
          `).bind(
            name,
            clean(body.mobile),
            clean(body.role),
            num(body.salary),
            clean(
              body.join_date ||
              body.joinDate
            ) ||
            todayIST(),
            bool(
              body.is_active ??
              body.active ??
              true
            ) ? 1 : 0
          ).run();

        return json({
          success: true,
          id:
            result.meta?.last_row_id ??
            null
        });
      }

      // ======================================================
      // STAFF UPDATE
      // ======================================================

      if (
        path === "/api/staff/update" &&
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

          return json({
            success: false,
            error:
              "Staff ID is required"
          },400);
        }

        const fields = [];
        const values = [];

        if (
          body.name !== undefined
        ) {
          fields.push("name=?");
          values.push(
            clean(body.name)
          );
        }

        if (
          body.mobile !== undefined
        ) {
          fields.push("mobile=?");
          values.push(
            clean(body.mobile)
          );
        }

        if (
          body.role !== undefined
        ) {
          fields.push("role=?");
          values.push(
            clean(body.role)
          );
        }

        if (
          body.salary !== undefined
        ) {
          fields.push("salary=?");
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
          body.is_active !== undefined
        ) {
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

          return json({
            success: false,
            error:
              "No fields to update"
          },400);
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

      // ======================================================
      // STAFF INACTIVE
      // ======================================================

      if (
        path ===
          "/api/staff/inactive" &&
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

          return json({
            success: false,
            error:
              "Staff ID is required"
          },400);
        }

        await db.prepare(`
          UPDATE staff
          SET
            is_active=0,
            updated_at=
              CURRENT_TIMESTAMP
          WHERE id=?
        `).bind(
          id
        ).run();

        return json({
          success: true,
          status:
            "inactive"
        });
      }

      // ======================================================
      // STAFF REMOVE
      // ======================================================

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

          return json({
            success: false,
            error:
              "Staff ID is required"
          },400);
        }

        // Soft remove:
        // We don't physically delete staff
        // because historical records may depend
        // on the staff member.
        await db.prepare(`
          UPDATE staff
          SET
            is_active=0,
            updated_at=
              CURRENT_TIMESTAMP
          WHERE id=?
        `).bind(
          id
        ).run();

        return json({
          success: true,
          removed: true
        });
      }

      // ======================================================
      // FULL DATABASE IMPORT
      // ======================================================

      if (
        path ===
          "/api/import/full" &&
        method === "POST"
      ) {

        const body =
          await request.json();

        const result =
          await fullDatabaseImport(
            db,
            body
          );

        return json({
          success: true,
          message:
            "Full database import completed",
          result
        });
      }

      // ======================================================
      // IMPORT STATUS
      // ======================================================

      if (
        path ===
          "/api/import/status" &&
        method === "GET"
      ) {

        const counts = {};

        const tables = [
          "orders",
          "order_items",
          "menu_items",
          "restaurant_tables",
          "expenses",
          "staff",
          "stock_items"
        ];

        for (
          const table of tables
        ) {

          if (
            await tableExists(
              db,
              table
            )
          ) {

            const row =
              await db.prepare(`
                SELECT COUNT(*) AS count
                FROM ${table}
              `).first();

            counts[table] =
              Number(
                row?.count || 0
              );

          } else {

            counts[table] = 0;
          }
        }

        return json({
          success: true,
          counts
        });
      }

      // ======================================================
      // 404
      // ======================================================

      return json({
        success: false,
        error:
          "API route not found",
        path
      },404);

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
      },500);
    }
  }
};
