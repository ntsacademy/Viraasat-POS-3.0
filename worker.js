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

  return result.results || [];
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

      addItem("order_id", orderId);
      addItem(
        "menu_item_id",
        item.id || item.menu_item_id || null
      );
      addItem("name", clean(item.name));
      addItem("quantity", num(item.qty,1));
      addItem("qty", num(item.qty,1));
      addItem("price", num(item.price));
      addItem("unit_price", num(item.price));
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
