// ============================================================
// VIRAASAT POS - ENTERPRISE EDITION
// Cloudflare Worker + D1 Database API
// FINAL D1 WORKER
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
  if (!value) {
    return new Date().toISOString();
  }

  return String(value).trim();
}

// ============================================================
// DATABASE HELPERS
// ============================================================

async function tableExists(db, table) {
  const result = await db
    .prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type='table'
      AND name=?
    `)
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

  return (result.results || []).map(
    row => row.name
  );
}

async function addColumnIfMissing(
  db,
  table,
  column,
  definition
) {
  const cols = await getColumns(
    db,
    table
  );

  if (
    cols.length &&
    !cols.includes(column)
  ) {
    try {
      await db.prepare(
        `ALTER TABLE ${table}
         ADD COLUMN ${column} ${definition}`
      ).run();
    } catch (e) {
      console.error(
        `Could not add ${column} to ${table}`,
        e
      );
    }
  }
}

// ============================================================
// SUPPORT TABLES / MIGRATIONS
// ============================================================

async function ensureSupportTables(db) {

  // ----------------------------------------------------------
  // STOCK
  // ----------------------------------------------------------

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

  // ----------------------------------------------------------
  // STAFF
  // ----------------------------------------------------------

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

  // ----------------------------------------------------------
  // EXPENSES
  // ----------------------------------------------------------

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

  await addColumnIfMissing(
    db,
    "expenses",
    "receipt_image",
    "TEXT"
  );

  // ----------------------------------------------------------
  // APPROVAL REQUESTS
  // ----------------------------------------------------------

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

  await addColumnIfMissing(
    db,
    "deletion_requests",
    "request_type",
    "TEXT DEFAULT 'order_delete'"
  );

  await addColumnIfMissing(
    db,
    "deletion_requests",
    "target_id",
    "TEXT"
  );

  // ----------------------------------------------------------
  // AUDIT LOGS
  // ----------------------------------------------------------

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      entity_type TEXT,
      entity_id TEXT,
      description TEXT,
      user_name TEXT,
      metadata TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
}

// ============================================================
// AUDIT LOG
// ============================================================

async function logAudit(
  db,
  {
    action,
    entityType = "",
    entityId = "",
    description = "",
    userName = "",
    metadata = null
  }
) {
  try {
    await ensureSupportTables(db);

    await db.prepare(`
      INSERT INTO audit_logs
      (
        action,
        entity_type,
        entity_id,
        description,
        user_name,
        metadata
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      clean(action),
      clean(entityType),
      clean(entityId),
      clean(description),
      clean(userName),
      metadata
        ? JSON.stringify(metadata)
        : null
    ).run();
  } catch (e) {
    console.error(
      "Audit log failed:",
      e
    );
  }
}

// ============================================================
// MENU
// ============================================================

async function getMenu(db) {

  if (
    !(await tableExists(
      db,
      "menu_items"
    ))
  ) {
    return [];
  }

  const cols =
    await getColumns(
      db,
      "menu_items"
    );

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

  const result =
    await db.prepare(`
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

async function importMenu(
  db,
  data,
  userName = "Admin"
) {

  if (!Array.isArray(data)) {
    throw new Error(
      "Menu data must be an array"
    );
  }

  const cols =
    await getColumns(
      db,
      "menu_items"
    );

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (
    const item of data
  ) {

    const name =
      clean(
        item.Name ??
        item.name ??
        item.Item_Name ??
        item.item_name
      );

    if (!name) {
      skipped++;
      continue;
    }

    const category =
      clean(
        item.Category ??
        item.category
      );

    const price =
      num(
        item.Price ??
        item.price
      );

    const gst =
      num(
        item.GST ??
        item.gst ??
        item.GST_Percent ??
        item.gst_percent
      );

    const active =
      bool(
        item.Active ??
        item.active ??
        item.Available ??
        item.available ??
        item.Is_Available ??
        item.is_available,
        true
      )
        ? 1
        : 0;

    const existing =
      await db.prepare(`
        SELECT id
        FROM menu_items
        WHERE LOWER(TRIM(name))
          = LOWER(TRIM(?))
        LIMIT 1
      `).bind(name).first();

    if (existing) {

      const updates = [];
      const values = [];

      if (
        cols.includes("category")
      ) {
        updates.push(
          "category=?"
        );
        values.push(category);
      }

      if (
        cols.includes("price")
      ) {
        updates.push(
          "price=?"
        );
        values.push(price);
      }

      if (
        cols.includes(
          "gst_percent"
        )
      ) {
        updates.push(
          "gst_percent=?"
        );
        values.push(gst);
      }

      if (
        cols.includes(
          "is_available"
        )
      ) {
        updates.push(
          "is_available=?"
        );
        values.push(active);
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
        values.push(category);
      }

      if (
        cols.includes("price")
      ) {
        fields.push("price");
        values.push(price);
      }

      if (
        cols.includes(
          "gst_percent"
        )
      ) {
        fields.push(
          "gst_percent"
        );
        values.push(gst);
      }

      if (
        cols.includes(
          "is_available"
        )
      ) {
        fields.push(
          "is_available"
        );
        values.push(active);
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
      `).bind(
        ...values
      ).run();

      inserted++;
    }
  }

  await logAudit(
    db,
    {
      action:
        "MENU_IMPORT",
      entityType:
        "menu",
      description:
        `Menu import completed: ${inserted} inserted, ${updated} updated`,
      userName,
      metadata: {
        inserted,
        updated,
        skipped
      }
    }
  );

  return {
    inserted,
    updated,
    skipped
  };
}

// ============================================================
// TABLES
// ============================================================

async function getTables(db) {

  if (
    !(await tableExists(
      db,
      "restaurant_tables"
    ))
  ) {
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
    cols.includes(
      "table_number"
    )
      ? "table_number"
      : "'' AS table_number";

  const seating =
    cols.includes(
      "seating_area"
    )
      ? "seating_area"
      : "'' AS seating_area";

  const status =
    cols.includes("status")
      ? "status"
      : "'available' AS status";

  const currentOrder =
    cols.includes(
      "current_order_id"
    )
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

async function getOrders(
  db,
  limit = 500
) {

  if (
    !(await tableExists(
      db,
      "orders"
    ))
  ) {
    return [];
  }

  const cols =
    await getColumns(
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
    cols.includes(
      "grand_total"
    )
      ? "grand_total"
      : cols.includes("total")
        ? "total AS grand_total"
        : "0 AS grand_total";

  const result =
    await db.prepare(`
      SELECT
        ${pick(
          "id",
          "rowid AS id"
        )},

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
        Math.max(
          num(limit, 500),
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

async function getExpenses(
  db,
  limit = 1000
) {

  if (
    !(await tableExists(
      db,
      "expenses"
    ))
  ) {
    return [];
  }

  const cols =
    await getColumns(
      db,
      "expenses"
    );

  const pick = (
    column,
    fallback
  ) =>
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
        Math.max(
          num(limit, 1000),
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

  const today =
    todayIST();

  const validOrders =
    orders.filter(
      order => {

        const status =
          String(
            order.order_status ||
            "completed"
          ).toLowerCase();

        return (
          status !== "cancelled" &&
          status !== "deleted" &&
          status !==
            "deletion_pending"
        );
      }
    );

  const todayOrders =
    validOrders.filter(
      order =>
        String(
          order.created_at ||
          ""
        ).startsWith(today)
    );

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

  const overallDiscount =
    validOrders.reduce(
      (sum, order) =>
        sum +
        num(
          order.discount
        ),
      0
    );

  const todayDiscount =
    todayOrders.reduce(
      (sum, order) =>
        sum +
        num(
          order.discount
        ),
      0
    );

  const totalExpenses =
    expenses.reduce(
      (sum, exp) =>
        sum +
        num(exp.amount),
      0
    );

  const todayExpenses =
    expenses
      .filter(
        exp =>
          String(
            exp.expense_date ||
            exp.created_at ||
            ""
          ).startsWith(today)
      )
      .reduce(
        (sum, exp) =>
          sum +
          num(exp.amount),
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
          table.status ||
          ""
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

  const cashSales =
    validOrders
      .filter(
        order =>
          String(
            order.payment_method ||
            ""
          ).toLowerCase() ===
          "cash"
      )
      .reduce(
        (sum, order) =>
          sum +
          num(
            order.grand_total
          ),
        0
      );

  const upiSales =
    validOrders
      .filter(
        order =>
          String(
            order.payment_method ||
            ""
          ).toLowerCase() ===
          "upi"
      )
      .reduce(
        (sum, order) =>
          sum +
          num(
            order.grand_total
          ),
        0
      );

  const lowStock =
    stock.filter(
      item =>
        Number(
          item.is_active
        ) === 1 &&
        num(item.quantity) <=
          num(
            item.low_stock_level,
            5
          )
    );

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

      overall_discount:
        overallDiscount,

      today_discount:
        todayDiscount,

      total_expenses:
        totalExpenses,

      today_expenses:
        todayExpenses,

      net_profit:
        overallSales -
        totalExpenses,

      cash_sales:
        cashSales,

      upi_sales:
        upiSales,

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

    low_stock:
      lowStock,

    staff,

    recent_orders:
      todayOrders.slice(
        0,
        10
      )
  };
}

// ============================================================
// ITEM-WISE SALES
// ============================================================

async function getItemSales(
  db,
  startDate = "",
  endDate = ""
) {

  if (
    !(await tableExists(
      db,
      "order_items"
    ))
  ) {
    return [];
  }

  const itemCols =
    await getColumns(
      db,
      "order_items"
    );

  const orderCols =
    await getColumns(
      db,
      "orders"
    );

  const itemNameCol =
    itemCols.includes(
      "item_name"
    )
      ? "item_name"
      : itemCols.includes("name")
        ? "name"
        : null;

  if (!itemNameCol) {
    return [];
  }

  const qtyCol =
    itemCols.includes(
      "quantity"
    )
      ? "quantity"
      : itemCols.includes("qty")
        ? "qty"
        : null;

  const priceCol =
    itemCols.includes(
      "total"
    )
      ? "total"
      : itemCols.includes(
          "line_total"
        )
        ? "line_total"
        : null;

  if (!qtyCol || !priceCol) {
    return [];
  }

  const orderIdCol =
    itemCols.includes(
      "order_id"
    )
      ? "order_id"
      : null;

  if (!orderIdCol) {
    return [];
  }

  const orderDateCol =
    orderCols.includes(
      "created_at"
    )
      ? "created_at"
      : null;

  const orderStatusCol =
    orderCols.includes(
      "order_status"
    )
      ? "order_status"
      : null;

  const orderJoin =
    `o.id = oi.order_id`;

  const where = [];
  const binds = [];

  if (
    startDate &&
    orderDateCol
  ) {
    where.push(
      `substr(o.${orderDateCol},1,10) >= ?`
    );
    binds.push(
      normalizeDate(startDate)
    );
  }

  if (
    endDate &&
    orderDateCol
  ) {
    where.push(
      `substr(o.${orderDateCol},1,10) <= ?`
    );
    binds.push(
      normalizeDate(endDate)
    );
  }

  if (
    orderStatusCol
  ) {
    where.push(`
      LOWER(
        COALESCE(
          o.${orderStatusCol},
          'completed'
        )
      ) NOT IN
      ('cancelled','deleted','deletion_pending')
    `);
  }

  const whereSql =
    where.length
      ? `WHERE ${where.join(" AND ")}`
      : "";

  const result =
    await db.prepare(`
      SELECT
        oi.${itemNameCol}
          AS item_name,

        SUM(
          COALESCE(
            oi.${qtyCol},
            0
          )
        ) AS quantity_sold,

        SUM(
          COALESCE(
            oi.${priceCol},
            0
          )
        ) AS sales_value,

        COUNT(
          DISTINCT oi.order_id
        ) AS order_count

      FROM order_items oi

      JOIN orders o
        ON ${orderJoin}

      ${whereSql}

      GROUP BY
        oi.${itemNameCol}

      ORDER BY
        sales_value DESC
    `).bind(
      ...binds
    ).all();

  return result.results || [];
}

// ============================================================
// UPDATE TABLE
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

  if (
    cols.includes("status")
  ) {
    updates.push(
      "status=?"
    );
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
    cols.includes(
      "updated_at"
    )
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
      CAST(
        table_number AS TEXT
      )=?
  `).bind(
    ...values,
    String(tableNumber)
  ).run();
}

// ============================================================
// ITEM PARSER
// ============================================================

function parseItemsString(
  itemsString
) {

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

  let parts =
    text
      .split(",")
      .map(
        x => x.trim()
      )
      .filter(Boolean);

  const items = [];

  for (
    const part of parts
  ) {

    const match =
      part.match(
        /^(.+?)\s*\(x\s*(\d+(?:\.\d+)?)\)\s*(?:₹\s*([\d,.]+))?\s*$/i
      );

    if (!match) {
      continue;
    }

    const name =
      clean(match[1]);

    const quantity =
      num(
        match[2],
        1
      );

    const total =
      match[3]
        ? num(match[3])
        : null;

    const price =
      total !== null &&
      quantity > 0
        ? total / quantity
        : null;

    items.push({
      name,
      qty:
        quantity,
      price,
      total
    });
  }

  return items;
}

// ============================================================
// MENU PRICE LOOKUP
// ============================================================

async function resolveItemPrices(
  db,
  items
) {

  if (!items.length) {
    return items;
  }

  const menu =
    await getMenu(db);

  const lookup =
    new Map();

  for (
    const item of menu
  ) {

    lookup.set(
      clean(item.name)
        .toLowerCase(),
      num(item.price)
    );
  }

  return items.map(
    item => {

      const key =
        clean(item.name)
          .toLowerCase();

      const menuPrice =
        lookup.get(key);

      const price =
        item.price !== null &&
        item.price !== undefined
          ? num(item.price)
          : num(menuPrice);

      const total =
        item.total !== null &&
        item.total !== undefined
          ? num(item.total)
          : price *
            num(item.qty,1);

      return {
        ...item,
        price,
        total
      };
    }
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

  if (
    cols.includes(
      "order_number"
    )
  ) {

    const existing =
      await db.prepare(`
        SELECT
          id,
          order_number
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

  items =
    await resolveItemPrices(
      db,
      items
    );

  const subtotal =
    num(
      body.subtotal,
      items.reduce(
        (
          sum,
          item
        ) =>
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
    num(
      body.discount
    );

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

  const add = (
    column,
    value
  ) => {

    if (
      cols.includes(
        column
      )
    ) {
      values[column] =
        value;
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
    tableNumber ||
      null
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
      items.map(
        item =>
          `${clean(item.name)} (x${num(item.qty,1)}) ₹${num(item.total, num(item.price) * num(item.qty,1))}`
      ).join(", ")
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

  // ----------------------------------------------------------
  // ORDER ITEMS
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

      const itemVals = {};

      const addItem = (
        column,
        value
      ) => {

        if (
          itemCols.includes(
            column
          )
        ) {
          itemVals[column] =
            value;
        }
      };

      addItem(
        "order_id",
        orderId
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
        "menu_item_id",
        item.id ||
          item.menu_item_id ||
          null
      );

      addItem(
        "quantity",
        num(item.qty,1)
      );

      if (
        itemCols.includes(
          "qty"
        )
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
          itemVals
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
            itemVals[field]
        )
      ).run();
    }
  }

  return {
    orderId,
    orderNumber,
    grandTotal,
    duplicate:
      false
  };
}

// ============================================================
// FULL DATABASE IMPORT
// ============================================================

async function fullDatabaseImport(
  db,
  body
) {

  await ensureSupportTables(
    db
  );

  const result = {
    menu: {
      inserted: 0,
      updated: 0,
      skipped: 0
    },

    stock: {
      inserted: 0,
      updated: 0,
      skipped: 0
    },

    staff: {
      inserted: 0,
      updated: 0,
      skipped: 0
    },

    expenses: {
      inserted: 0,
      skipped: 0
    },

    sales: {
      inserted: 0,
      duplicate: 0,
      failed: 0
    },

    order_items: {
      inserted: 0
    }
  };

  // ==========================================================
  // MENU
  // ==========================================================

  if (
    Array.isArray(body.menu)
  ) {

    result.menu =
      await importMenu(
        db,
        body.menu,
        body.user_name ||
        "Admin"
      );
  }

  // ==========================================================
  // STOCK
  // ==========================================================

  if (
    Array.isArray(body.stock)
  ) {

    for (
      const item of body.stock
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
          item.LowStock,
          5
        );

      const existing =
        await db.prepare(`
          SELECT id
          FROM stock_items
          WHERE LOWER(TRIM(name))
            = LOWER(TRIM(?))
          LIMIT 1
        `).bind(
          name
        ).first();

      if (existing) {

        await db.prepare(`
          UPDATE stock_items
          SET
            quantity=?,
            unit=?,
            low_stock_level=?,
            is_active=1,
            updated_at=
              CURRENT_TIMESTAMP
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
          (?, ?, ?, ?, 1)
        `).bind(
          name,
          quantity,
          unit,
          lowStock
        ).run();

        result.stock.inserted++;
      }
    }
  }

  // ==========================================================
  // STAFF
  // ==========================================================

  if (
    Array.isArray(body.staff)
  ) {

    for (
      const person of body.staff
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
            LOWER(TRIM(name))
            =
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
            updated_at=
              CURRENT_TIMESTAMP
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
          (?, ?, ?, ?, ?, ?)
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
  }

  // ==========================================================
  // EXPENSES
  // ==========================================================

  if (
    Array.isArray(body.expenses) &&
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
      const expense of body.expenses
    ) {

      const amount =
        num(
          expense.Amount ??
          expense.amount
        );

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

      const expenseDate =
        normalizeDate(
          expense.Date ??
          expense.date ??
          expense.expense_date
        );

      if (
        !amount &&
        !category &&
        !description
      ) {
        result.expenses.skipped++;
        continue;
      }

      const fields = [];
      const values = [];

      if (
        expenseCols.includes(
          "category"
        )
      ) {
        fields.push(
          "category"
        );
        values.push(
          category
        );
      }

      if (
        expenseCols.includes(
          "amount"
        )
      ) {
        fields.push(
          "amount"
        );
        values.push(
          amount
        );
      }

      if (
        expenseCols.includes(
          "description"
        )
      ) {
        fields.push(
          "description"
        );
        values.push(
          description
        );
      }

      if (
        expenseCols.includes(
          "expense_date"
        )
      ) {
        fields.push(
          "expense_date"
        );
        values.push(
          expenseDate
        );
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
      `).bind(
        ...values
      ).run();

      result.expenses.inserted++;
    }
  }

  // ==========================================================
  // SALES
  // ==========================================================

  if (
    Array.isArray(body.sales)
  ) {

    for (
      const sale of body.sales
    ) {

      try {

        const orderNumber =
          clean(
            sale.Order_ID ??
            sale.order_id ??
            sale.order_number ??
            sale.orderNumber
          );

        if (!orderNumber) {
          result.sales.failed++;
          continue;
        }

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

        const tableNumber =
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
          ) ||
          "Cash";

        const rawItems =
          clean(
            sale.Items ??
            sale.items ??
            sale.items_string
          );

        let items =
          parseItemsString(
            rawItems
          );

        items =
          await resolveItemPrices(
            db,
            items
          );

        const itemSubtotal =
          items.reduce(
            (
              sum,
              item
            ) =>
              sum +
              num(
                item.total
              ),
            0
          );

        const subtotal =
          itemSubtotal ||
          Math.max(
            total +
            discount,
            0
          );

        const orderType =
          /^table\s*/i.test(
            tableNumber
          )
            ? "Dine-in"
            : "Takeaway";

        let createdAt =
          `${date} ${time}`;

        if (
          /^\d{1,2}:\d{2}\s?(AM|PM)$/i.test(
            time
          )
        ) {

          const match =
            time.match(
              /^(\d{1,2}):(\d{2})\s?(AM|PM)$/i
            );

          if (match) {

            let hour =
              Number(
                match[1]
              );

            const minute =
              match[2];

            const ampm =
              match[3].toUpperCase();

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

        const orderCols =
          await getColumns(
            db,
            "orders"
          );

        const values = {};

        const addOrder = (
          column,
          value
        ) => {

          if (
            orderCols.includes(
              column
            )
          ) {
            values[column] =
              value;
          }
        };

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
          tableNumber ||
            null
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
          payment
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
          "items",
          JSON.stringify(items)
        );

        addOrder(
          "items_string",
          rawItems
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
          Object.keys(
            values
          );

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

        if (
          orderId &&
          items.length &&
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

            const itemVals = {};

            const addItem = (
              column,
              value
            ) => {

              if (
                itemCols.includes(
                  column
                )
              ) {
                itemVals[column] =
                  value;
              }
            };

            addItem(
              "order_id",
              orderId
            );

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
                itemVals
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
                  itemVals[field]
              )
            ).run();

            result.order_items.inserted++;
          }
        }

      } catch (error) {

        console.error(
          "Sales import error:",
          error
        );

        result.sales.failed++;
      }
    }
  }

  await logAudit(
    db,
    {
      action:
        "FULL_IMPORT",
      entityType:
        "database",
      description:
        "Master database import completed",
      userName:
        body.user_name ||
        "Admin",
      metadata:
        result
    }
  );

  return result;
}

// ============================================================
// MAIN WORKER ROUTER
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

    // ========================================================
    // OPTIONS
    // ========================================================

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

        return json(
          {
            success: false,
            error:
              "D1 Database Binding is missing"
          },
          500
        );
      }

      // ======================================================
      // ROOT
      // ======================================================

      if (
        path === "/"
      ) {

        return new Response(
          "Viraasat POS Enterprise API Running",
          {
            status: 200
          }
        );
      }

      // ======================================================
      // HEALTH
      // ======================================================

      if (
        path ===
          "/api/health"
      ) {

        return json({
          success: true,
          application:
            "Viraasat POS Enterprise",
          status:
            "online",
          database:
            "connected"
        });
      }

      // ======================================================
      // TEST DB
      // ======================================================

      if (
        path ===
          "/api/test-db"
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
            "connected",
          result
        });
      }

      // ======================================================
      // DASHBOARD
      // ======================================================

      if (
        path ===
          "/api/dashboard" &&
        method === "GET"
      ) {

        return json(
          await getDashboard(
            db
          )
        );
      }

      // ======================================================
      // ITEM SALES
      // ======================================================

      if (
        path ===
          "/api/item-sales" &&
        method === "GET"
      ) {

        const params =
          url.searchParams;

        const startDate =
          params.get(
            "start_date"
          ) || "";

        const endDate =
          params.get(
            "end_date"
          ) || "";

        const items =
          await getItemSales(
            db,
            startDate,
            endDate
          );

        return json({
          success: true,
          items
        });
      }

      // ======================================================
      // MENU GET
      // ======================================================

      if (
        path ===
          "/api/menu" &&
        method === "GET"
      ) {

        return json({
          success: true,
          items:
            await getMenu(db)
        });
      }

      // ======================================================
      // MENU POST
      // ======================================================

      if (
        path ===
          "/api/menu" &&
        method === "POST"
      ) {

        const body =
          await request.json();

        const name =
          clean(
            body.name
          );

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
            num(
              body.gst_percent
            )
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

        await logAudit(
          db,
          {
            action:
              "MENU_ADD",
            entityType:
              "menu",
            entityId:
              String(
                result.meta?.last_row_id ??
                ""
              ),
            description:
              `Menu item added: ${name}`,
            userName:
              clean(
                body.user_name
              ) ||
              "Admin"
          }
        );

        return json({
          success: true,
          id:
            result.meta?.last_row_id ??
            null
        });
      }

      // ======================================================
      // MENU IMPORT
      // ======================================================

      if (
        path ===
          "/api/menu/import" &&
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
            data,
            body.user_name ||
            "Admin"
          );

        return json({
          success: true,
          ...result
        });
      }

      // ======================================================
      // TABLES
      // ======================================================

      if (
        path ===
          "/api/tables" &&
        method === "GET"
      ) {

        return json({
          success: true,
          tables:
            await getTables(db)
        });
      }

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

        await logAudit(
          db,
          {
            action:
              "TABLE_CLEAR",
            entityType:
              "table",
            entityId:
              tableNumber,
            description:
              `Table ${tableNumber} cleared`,
            userName:
              clean(
                body.user_name
              ) ||
              "Staff"
          }
        );

        return json({
          success: true
        });
      }

      // ======================================================
      // ORDERS GET
      // ======================================================

      if (
        path ===
          "/api/orders" &&
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

      // ======================================================
      // SAVE KOT
      // ======================================================

      if (
        path ===
          "/api/orders" &&
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

        if (
          !result.duplicate
        ) {

          await logAudit(
            db,
            {
              action:
                "KOT_SAVED",
              entityType:
                "order",
              entityId:
                result.orderNumber,
              description:
                `KOT saved: ${result.orderNumber}`,
              userName:
                clean(
                  body.user_name
                ) ||
                "Staff",
              metadata: {
                total:
                  result.grandTotal
              }
            }
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

        if (
          !result.duplicate
        ) {

          await logAudit(
            db,
            {
              action:
                "CHECKOUT",
              entityType:
                "order",
              entityId:
                result.orderNumber,
              description:
                `Checkout completed: ${result.orderNumber}`,
              userName:
                clean(
                  body.user_name
                ) ||
                "Staff",
              metadata: {
                total:
                  result.grandTotal,
                payment_method:
                  body.payment_method ||
                  body.paymentMethod ||
                  "Cash"
              }
            }
          );
        }

        return json({
          success: true,
          ...result
        });
      }

      // ======================================================
      // ORDER DELETE REQUEST
      // ======================================================

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
          clean(
            body.order_id
          );

        const reason =
          clean(
            body.reason
          );

        const reqBy =
          clean(
            body.requested_by
          ) ||
          "Staff";

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
            status,
            request_type,
            target_id
          )
          VALUES
          (?, ?, ?, 'pending', 'order_delete', ?)
        `).bind(
          orderId,
          reqBy,
          reason,
          orderId
        ).run();

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
            SET
              order_status =
                'deletion_pending'
            WHERE
              order_number=?
              OR id=?
          `).bind(
            orderId,
            orderId
          ).run();
        }

        await logAudit(
          db,
          {
            action:
              "ORDER_DELETE_REQUEST",
            entityType:
              "order",
            entityId:
              orderId,
            description:
              `Order deletion requested: ${orderId}`,
            userName:
              reqBy,
            metadata: {
              reason
            }
          }
        );

        return json({
          success: true,
          message:
            "Deletion request submitted for approval"
        });
      }

      // ======================================================
      // APPROVALS GET
      // ======================================================

      if (
        path ===
          "/api/approvals" &&
        method === "GET"
      ) {

        await ensureSupportTables(
          db
        );

        const requests =
          await db.prepare(`
            SELECT *
            FROM deletion_requests
            WHERE status='pending'
            ORDER BY id DESC
          `).all();

        return json({
          success: true,
          requests:
            requests.results ||
            []
        });
      }

      // ======================================================
      // APPROVAL RESOLVE
      // ======================================================

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
          num(
            body.request_id
          );

        const status =
          clean(
            body.status
          ).toLowerCase();

        const orderId =
          clean(
            body.order_id
          );

        const reviewedBy =
          clean(
            body.reviewed_by
          ) ||
          "Admin";

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

        const requestRow =
          await db.prepare(`
            SELECT *
            FROM deletion_requests
            WHERE id=?
            LIMIT 1
          `).bind(
            requestId
          ).first();

        if (!requestRow) {

          return json(
            {
              success: false,
              error:
                "Approval request not found"
            },
            404
          );
        }

        const targetId =
          orderId ||
          clean(
            requestRow.target_id
          ) ||
          clean(
            requestRow.order_id
          );

        await db.prepare(`
          UPDATE deletion_requests
          SET
            status=?,
            reviewed_by=?,
            reviewed_at=
              CURRENT_TIMESTAMP
          WHERE id=?
        `).bind(
          status,
          reviewedBy,
          requestId
        ).run();

        const requestType =
          clean(
            requestRow.request_type
          ) ||
          "order_delete";

        // ------------------------------------------------------
        // ORDER DELETE APPROVAL
        // ------------------------------------------------------

        if (
          requestType ===
            "order_delete"
        ) {

          if (
            status ===
              "approved"
          ) {

            await db.prepare(`
              UPDATE orders
              SET
                order_status='deleted'
              WHERE
                order_number=?
                OR id=?
            `).bind(
              targetId,
              targetId
            ).run();

          }
          else if (
            status ===
              "rejected"
          ) {

            await db.prepare(`
              UPDATE orders
              SET
                order_status='completed'
              WHERE
                order_number=?
                OR id=?
            `).bind(
              targetId,
              targetId
            ).run();
          }
        }

        // ------------------------------------------------------
        // STAFF REMOVE APPROVAL
        // ------------------------------------------------------

        if (
          requestType ===
            "staff_remove"
        ) {

          if (
            status ===
              "approved"
          ) {

            await db.prepare(`
              UPDATE staff
              SET
                is_active=0,
                updated_at=
                  CURRENT_TIMESTAMP
              WHERE id=?
            `).bind(
              num(targetId)
            ).run();

          }
        }

        await logAudit(
          db,
          {
            action:
              "APPROVAL_RESOLVED",
            entityType:
              requestType,
            entityId:
              targetId,
            description:
              `Approval ${status}: ${targetId}`,
            userName:
              reviewedBy,
            metadata: {
              requestId
            }
          }
        );

        return json({
          success: true,
          message:
            `Request ${status}`
        });
      }

      // ======================================================
      // EXPENSES GET
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
          cols.includes("amount")
        ) {
          fields.push(
            "amount"
          );
          values.push(
            num(body.amount)
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

        const result =
          await db.prepare(`
            INSERT INTO expenses
            (${fields.join(",")})
            VALUES
            (${fields.map(() => "?").join(",")})
          `).bind(
            ...values
          ).run();

        await logAudit(
          db,
          {
            action:
              "EXPENSE_ADDED",
            entityType:
              "expense",
            entityId:
              String(
                result.meta?.last_row_id ??
                ""
              ),
            description:
              `Expense added: ₹${num(body.amount)}`,
            userName:
              clean(
                body.user_name
              ) ||
              "Staff",
            metadata: {
              category:
                body.category,
              amount:
                num(body.amount)
            }
          }
        );

        return json({
          success: true
        });
      }

      // ======================================================
      // STOCK GET
      // ======================================================

      if (
        path ===
          "/api/stock" &&
        method === "GET"
      ) {

        return json({
          success: true,
          stock:
            await getStock(
              db
            )
        });
      }

      // ======================================================
      // STOCK POST
      // ======================================================

      if (
        path ===
          "/api/stock" &&
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
          ) ||
          "pcs",
          num(
            body.low_stock_level,
            5
          )
        ).run();

        await logAudit(
          db,
          {
            action:
              "STOCK_UPDATED",
            entityType:
              "stock",
            entityId:
              name,
            description:
              `Stock updated: ${name}`,
            userName:
              clean(
                body.user_name
              ) ||
              "Staff"
          }
        );

        return json({
          success: true
        });
      }

      // ======================================================
      // STAFF GET
      // ======================================================

      if (
        path ===
          "/api/staff" &&
        method === "GET"
      ) {

        return json({
          success: true,
          staff:
            await getStaff(
              db
            )
        });
      }

      // ======================================================
      // STAFF ADD
      // ======================================================

      if (
        path ===
          "/api/staff" &&
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
          `).bind(
            name,
            clean(
              body.mobile
            ),
            clean(
              body.role
            ),
            num(
              body.salary
            ),
            clean(
              body.join_date ||
              body.joinDate
            ) ||
            todayIST(),
            bool(
              body.is_active ??
              body.active ??
              true
            )
              ? 1
              : 0
          ).run();

        await logAudit(
          db,
          {
            action:
              "STAFF_ADDED",
            entityType:
              "staff",
            entityId:
              String(
                result.meta?.last_row_id ??
                ""
              ),
            description:
              `Staff added: ${name}`,
            userName:
              clean(
                body.user_name
              ) ||
              "Admin"
          }
        );

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
          num(
            body.id
          );

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
          body.name !==
          undefined
        ) {
          fields.push(
            "name=?"
          );
          values.push(
            clean(
              body.name
            )
          );
        }

        if (
          body.mobile !==
          undefined
        ) {
          fields.push(
            "mobile=?"
          );
          values.push(
            clean(
              body.mobile
            )
          );
        }

        if (
          body.role !==
          undefined
        ) {
          fields.push(
            "role=?"
          );
          values.push(
            clean(
              body.role
            )
          );
        }

        if (
          body.salary !==
          undefined
        ) {
          fields.push(
            "salary=?"
          );
          values.push(
            num(
              body.salary
            )
          );
        }

        if (
          body.join_date !==
          undefined
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
        `).bind(
          ...values,
          id
        ).run();

        await logAudit(
          db,
          {
            action:
              "STAFF_UPDATED",
            entityType:
              "staff",
            entityId:
              String(id),
            description:
              `Staff updated: ${id}`,
            userName:
              clean(
                body.user_name
              ) ||
              "Admin"
          }
        );

        return json({
          success: true
        });
      }

      // ======================================================
      // STAFF REMOVE REQUEST
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
          num(
            body.id
          );

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

        const staffMember =
          await db.prepare(`
            SELECT id, name
            FROM staff
            WHERE id=?
            LIMIT 1
          `).bind(
            id
          ).first();

        if (!staffMember) {

          return json(
            {
              success: false,
              error:
                "Staff member not found"
            },
            404
          );
        }

        await db.prepare(`
          INSERT INTO deletion_requests
          (
            order_id,
            requested_by,
            reason,
            status,
            request_type,
            target_id
          )
          VALUES
          (?, ?, ?, 'pending', 'staff_remove', ?)
        `).bind(
          `STAFF:${id}`,
          clean(
            body.requested_by
          ) ||
          "Staff",
          clean(
            body.reason
          ) ||
          `Remove staff: ${staffMember.name}`,
          String(id)
        ).run();

        await logAudit(
          db,
          {
            action:
              "STAFF_REMOVE_REQUEST",
            entityType:
              "staff",
            entityId:
              String(id),
            description:
              `Staff removal requested: ${staffMember.name}`,
            userName:
              clean(
                body.requested_by
              ) ||
              "Staff"
          }
        );

        return json({
          success: true,
          pending:
            true,
          message:
            "Staff removal request submitted for approval"
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
          num(
            body.id
          );

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
        `).bind(
          id
        ).run();

        await logAudit(
          db,
          {
            action:
              "STAFF_INACTIVE",
            entityType:
              "staff",
            entityId:
              String(id),
            description:
              `Staff marked inactive: ${id}`,
            userName:
              clean(
                body.user_name
              ) ||
              "Admin"
          }
        );

        return json({
          success: true,
          status:
            "inactive"
        });
      }

      // ======================================================
      // FULL IMPORT
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
          "stock_items",
          "audit_logs",
          "deletion_requests"
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
                SELECT
                  COUNT(*) AS count
                FROM ${table}
              `).first();

            counts[table] =
              Number(
                row?.count ||
                0
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
      // AUDIT LOGS GET
      // ======================================================

      if (
        path ===
          "/api/audit" &&
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
                ),
                500
              ),
              1
            ),
            5000
          );

        const result =
          await db.prepare(`
            SELECT
              id,
              action,
              entity_type,
              entity_id,
              description,
              user_name,
              metadata,
              created_at
            FROM audit_logs
            ORDER BY id DESC
            LIMIT ?
          `).bind(
            limit
          ).all();

        return json({
          success: true,
          logs:
            result.results ||
            []
        });
      }

      // ======================================================
      // AUDIT LOG POST
      // ======================================================

      if (
        path ===
          "/api/audit" &&
        method === "POST"
      ) {

        const body =
          await request.json();

        await logAudit(
          db,
          {
            action:
              body.action ||
              "USER_ACTION",
            entityType:
              body.entity_type ||
              body.entityType ||
              "",
            entityId:
              body.entity_id ||
              body.entityId ||
              "",
            description:
              body.description ||
              "",
            userName:
              body.user_name ||
              body.userName ||
              "User",
            metadata:
              body.metadata ||
              null
          }
        );

        return json({
          success: true
        });
      }

      // ======================================================
      // 404
      // ======================================================

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
