// ============================================================
// VIRAASAT POS 3.0
// Cloudflare Worker + D1 Database
// Complete Worker.js
// ============================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ----------------------------------------------------------
    // CORS
    // ----------------------------------------------------------
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Type": "application/json"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    // ----------------------------------------------------------
    // Helper: JSON Response
    // ----------------------------------------------------------
    function json(data, status = 200) {
      return new Response(JSON.stringify(data), {
        status,
        headers: corsHeaders
      });
    }

    // ----------------------------------------------------------
    // Helper: Error Response
    // ----------------------------------------------------------
    function errorResponse(message, status = 500) {
      return json({
        success: false,
        error: message
      }, status);
    }

    // ==========================================================
    // 1. TEST DATABASE
    // ==========================================================
    if (
      url.pathname === "/api/test-db" &&
      request.method === "GET"
    ) {
      try {
        const result = await env.DB
          .prepare("SELECT 1 AS ok")
          .first();

        return json({
          success: true,
          database: "connected",
          result
        });
      } catch (error) {
        return errorResponse(error.message);
      }
    }

    // ==========================================================
    // 2. MENU IMPORT
    // ==========================================================
    if (
      url.pathname === "/api/menu/import" &&
      request.method === "POST"
    ) {
      try {
        const body = await request.json();

        // Accept:
        // [ ... ]
        // { data: [ ... ] }
        // { items: [ ... ] }

        const data = Array.isArray(body)
          ? body
          : Array.isArray(body?.data)
            ? body.data
            : Array.isArray(body?.items)
              ? body.items
              : null;

        if (!Array.isArray(data)) {
          return errorResponse(
            "Data must be an array",
            400
          );
        }

        let imported = 0;

        for (const item of data) {
          const name =
            item.Item_Name ??
            item.item_name ??
            item.Name ??
            item.name ??
            "";

          const category =
            item.Category ??
            item.category ??
            "";

          const rawPrice =
            item.Price ??
            item.price ??
            0;

          const rawGST =
            item.GST_Percent ??
            item.gst_percent ??
            item.GST ??
            0;

          const rawAvailable =
            item.Available ??
            item.available ??
            item.is_available ??
            1;

          const price = Number(
            String(rawPrice).replace(/[₹,\s]/g, "")
          ) || 0;

          const gstPercent = Number(
            String(rawGST).replace("%", "").trim()
          ) || 0;

          const isAvailable =
            String(rawAvailable).toLowerCase() === "no" ||
            String(rawAvailable).toLowerCase() === "false" ||
            String(rawAvailable) === "0"
              ? 0
              : 1;

          if (!name.trim()) {
            continue;
          }

          await env.DB
            .prepare(`
              INSERT INTO menu_items
              (name, category, price, gst_percent, is_available)
              VALUES (?, ?, ?, ?, ?)
            `)
            .bind(
              name.trim(),
              category.trim(),
              price,
              gstPercent,
              isAvailable
            )
            .run();

          imported++;
        }

        return json({
          success: true,
          imported
        });

      } catch (error) {
        return errorResponse(error.message);
      }
    }

    // ==========================================================
    // 3. GET MENU
    // ==========================================================
    if (
      url.pathname === "/api/menu" &&
      request.method === "GET"
    ) {
      try {
        const { results } = await env.DB
          .prepare(`
            SELECT
              id,
              name,
              category,
              price,
              gst_percent,
              is_available,
              created_at,
              updated_at
            FROM menu_items
            WHERE is_available = 1
            ORDER BY category, name
          `)
          .all();

        return json({
          success: true,
          items: results || []
        });

      } catch (error) {
        return errorResponse(error.message);
      }
    }

    // ==========================================================
    // 4. GET ALL MENU INCLUDING DISABLED
    // ==========================================================
    if (
      url.pathname === "/api/menu/all" &&
      request.method === "GET"
    ) {
      try {
        const { results } = await env.DB
          .prepare(`
            SELECT
              id,
              name,
              category,
              price,
              gst_percent,
              is_available,
              created_at,
              updated_at
            FROM menu_items
            ORDER BY category, name
          `)
          .all();

        return json({
          success: true,
          items: results || []
        });

      } catch (error) {
        return errorResponse(error.message);
      }
    }

    // ==========================================================
    // 5. GET RESTAURANT TABLES
    // ==========================================================
    if (
      url.pathname === "/api/tables" &&
      request.method === "GET"
    ) {
      try {
        const { results } = await env.DB
          .prepare(`
            SELECT
              id,
              table_number,
              seating_area,
              status,
              current_order_id,
              created_at,
              updated_at
            FROM restaurant_tables
            ORDER BY CAST(table_number AS INTEGER)
          `)
          .all();

        return json({
          success: true,
          tables: results || []
        });

      } catch (error) {
        return errorResponse(error.message);
      }
    }

    // ==========================================================
    // 6. UPDATE TABLE STATUS
    // ==========================================================
    const tableMatch = url.pathname.match(
      /^\/api\/tables\/([^/]+)$/
    );

    if (
      tableMatch &&
      request.method === "PUT"
    ) {
      try {
        const tableNumber = decodeURIComponent(
          tableMatch[1]
        );

        const body = await request.json();

        const status =
          body.status ||
          "available";

        const allowedStatuses = [
          "available",
          "occupied",
          "reserved",
          "cleaning"
        ];

        if (!allowedStatuses.includes(status)) {
          return errorResponse(
            "Invalid table status",
            400
          );
        }

        await env.DB
          .prepare(`
            UPDATE restaurant_tables
            SET
              status = ?,
              updated_at = CURRENT_TIMESTAMP
            WHERE table_number = ?
          `)
          .bind(
            status,
            tableNumber
          )
          .run();

        const table = await env.DB
          .prepare(`
            SELECT
              id,
              table_number,
              seating_area,
              status,
              current_order_id,
              created_at,
              updated_at
            FROM restaurant_tables
            WHERE table_number = ?
          `)
          .bind(tableNumber)
          .first();

        return json({
          success: true,
          table
        });

      } catch (error) {
        return errorResponse(error.message);
      }
    }

    // ==========================================================
    // 7. GET ALL ORDERS
    // ==========================================================
    if (
      url.pathname === "/api/orders" &&
      request.method === "GET"
    ) {
      try {
        const limit = Math.min(
          Number(url.searchParams.get("limit")) || 50,
          200
        );

        const { results } = await env.DB
          .prepare(`
            SELECT
              id,
              order_number,
              table_number,
              order_type,
              customer_name,
              customer_phone,
              delivery_address,
              subtotal,
              gst_amount,
              discount_amount,
              grand_total,
              payment_method,
              payment_status,
              order_status,
              created_at,
              updated_at
            FROM orders
            ORDER BY id DESC
            LIMIT ?
          `)
          .bind(limit)
          .all();

        return json({
          success: true,
          orders: results || []
        });

      } catch (error) {
        return errorResponse(error.message);
      }
    }

    // ==========================================================
    // 8. CREATE NEW ORDER
    // ==========================================================
    if (
      url.pathname === "/api/orders" &&
      request.method === "POST"
    ) {
      try {
        const body = await request.json();

        const orderType =
          body.order_type ||
          body.orderType ||
          "Dine-In";

        const tableNumber =
          body.table_number ??
          body.tableNumber ??
          null;

        const customerName =
          body.customer_name ??
          body.customerName ??
          null;

        const customerPhone =
          body.customer_phone ??
          body.customerPhone ??
          null;

        const deliveryAddress =
          body.delivery_address ??
          body.deliveryAddress ??
          null;

        const discountAmount =
          Number(
            body.discount_amount ??
            body.discountAmount ??
            0
          ) || 0;

        const paymentMethod =
          body.payment_method ??
          body.paymentMethod ??
          null;

        const paymentStatus =
          body.payment_status ??
          body.paymentStatus ??
          "pending";

        const items = Array.isArray(body.items)
          ? body.items
          : [];

        if (items.length === 0) {
          return errorResponse(
            "Order must contain at least one item",
            400
          );
        }

        // ------------------------------------------------------
        // Generate unique order number
        // ------------------------------------------------------
        const now = new Date();

        const datePart =
          now.getFullYear().toString() +
          String(now.getMonth() + 1).padStart(2, "0") +
          String(now.getDate()).padStart(2, "0");

        const timePart =
          String(now.getHours()).padStart(2, "0") +
          String(now.getMinutes()).padStart(2, "0") +
          String(now.getSeconds()).padStart(2, "0");

        const randomPart =
          Math.floor(
            Math.random() * 900
          ) + 100;

        const orderNumber =
          `ORD-${datePart}-${timePart}-${randomPart}`;

        // ------------------------------------------------------
        // Calculate totals
        // ------------------------------------------------------
        let subtotal = 0;
        let gstAmount = 0;

        const processedItems = [];

        for (const item of items) {
          const menuItemId =
            item.menu_item_id ??
            item.menuItemId ??
            item.id ??
            null;

          let itemName =
            item.item_name ??
            item.itemName ??
            item.name ??
            "";

          let unitPrice =
            Number(
              item.unit_price ??
              item.unitPrice ??
              item.price ??
              0
            ) || 0;

          let gstPercent =
            Number(
              item.gst_percent ??
              item.gstPercent ??
              item.gst ??
              0
            ) || 0;

          const quantity =
            Math.max(
              1,
              Number(
                item.quantity ??
                item.qty ??
                1
              ) || 1
            );

          // ----------------------------------------------------
          // If menu_item_id is supplied, get actual menu data
          // ----------------------------------------------------
          if (menuItemId) {
            const menuItem = await env.DB
              .prepare(`
                SELECT
                  id,
                  name,
                  price,
                  gst_percent,
                  is_available
                FROM menu_items
                WHERE id = ?
              `)
              .bind(menuItemId)
              .first();

            if (!menuItem) {
              return errorResponse(
                `Menu item ${menuItemId} not found`,
                400
              );
            }

            if (!menuItem.is_available) {
              return errorResponse(
                `${menuItem.name} is currently unavailable`,
                400
              );
            }

            itemName = menuItem.name;
            unitPrice = Number(menuItem.price) || 0;
            gstPercent =
              Number(menuItem.gst_percent) || 0;
          }

          if (!itemName.trim()) {
            return errorResponse(
              "Item name is required",
              400
            );
          }

          const itemSubtotal =
            unitPrice * quantity;

          const itemGST =
            itemSubtotal *
            (gstPercent / 100);

          const itemTotal =
            itemSubtotal + itemGST;

          subtotal += itemSubtotal;
          gstAmount += itemGST;

          processedItems.push({
            menuItemId,
            itemName,
            quantity,
            unitPrice,
            gstPercent,
            itemTotal
          });
        }

        const safeDiscount =
          Math.max(
            0,
            Math.min(
              discountAmount,
              subtotal + gstAmount
            )
          );

        const grandTotal =
          subtotal +
          gstAmount -
          safeDiscount;

        // ------------------------------------------------------
        // Insert Order
        // ------------------------------------------------------
        const orderResult = await env.DB
          .prepare(`
            INSERT INTO orders
            (
              order_number,
              table_number,
              order_type,
              customer_name,
              customer_phone,
              delivery_address,
              subtotal,
              gst_amount,
              discount_amount,
              grand_total,
              payment_method,
              payment_status,
              order_status
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .bind(
            orderNumber,
            tableNumber,
            orderType,
            customerName,
            customerPhone,
            deliveryAddress,
            subtotal,
            gstAmount,
            safeDiscount,
            grandTotal,
            paymentMethod,
            paymentStatus,
            "open"
          )
          .run();

        const orderId =
          orderResult.meta?.last_row_id;

        if (!orderId) {
          return errorResponse(
            "Order was created but order ID was not returned"
          );
        }

        // ------------------------------------------------------
        // Insert Order Items
        // ------------------------------------------------------
        for (const item of processedItems) {
          await env.DB
            .prepare(`
              INSERT INTO order_items
              (
                order_id,
                menu_item_id,
                item_name,
                quantity,
                unit_price,
                gst_percent,
                item_total
              )
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `)
            .bind(
              orderId,
              item.menuItemId,
              item.itemName,
              item.quantity,
              item.unitPrice,
              item.gstPercent,
              item.itemTotal
            )
            .run();
        }

        // ------------------------------------------------------
        // Mark Dine-In table occupied
        // ------------------------------------------------------
        if (
          tableNumber !== null &&
          orderType.toLowerCase() === "dine-in"
        ) {
          await env.DB
            .prepare(`
              UPDATE restaurant_tables
              SET
                status = 'occupied',
                current_order_id = ?,
                updated_at = CURRENT_TIMESTAMP
              WHERE table_number = ?
            `)
            .bind(
              orderId,
              String(tableNumber)
            )
            .run();
        }

        return json({
          success: true,
          order: {
            id: orderId,
            order_number: orderNumber,
            table_number: tableNumber,
            order_type: orderType,
            subtotal,
            gst_amount: gstAmount,
            discount_amount: safeDiscount,
            grand_total: grandTotal,
            payment_method: paymentMethod,
            payment_status: paymentStatus,
            order_status: "open"
          },
          items: processedItems
        });

      } catch (error) {
        return errorResponse(error.message);
      }
    }

    // ==========================================================
    // 9. GET SINGLE ORDER
    // ==========================================================
    const singleOrderMatch =
      url.pathname.match(
        /^\/api\/orders\/(\d+)$/
      );

    if (
      singleOrderMatch &&
      request.method === "GET"
    ) {
      try {
        const orderId =
          Number(singleOrderMatch[1]);

        const order = await env.DB
          .prepare(`
            SELECT
              id,
              order_number,
              table_number,
              order_type,
              customer_name,
              customer_phone,
              delivery_address,
              subtotal,
              gst_amount,
              discount_amount,
              grand_total,
              payment_method,
              payment_status,
              order_status,
              created_at,
              updated_at
            FROM orders
            WHERE id = ?
          `)
          .bind(orderId)
          .first();

        if (!order) {
          return errorResponse(
            "Order not found",
            404
          );
        }

        const { results: items } =
          await env.DB
            .prepare(`
              SELECT
                id,
                order_id,
                menu_item_id,
                item_name,
                quantity,
                unit_price,
                gst_percent,
                item_total,
                created_at
              FROM order_items
              WHERE order_id = ?
              ORDER BY id
            `)
            .bind(orderId)
            .all();

        return json({
          success: true,
          order,
          items: items || []
        });

      } catch (error) {
        return errorResponse(error.message);
      }
    }

    // ==========================================================
    // 10. CLOSE / COMPLETE ORDER
    // POST /api/orders/:id/close
    // ==========================================================
    const closeOrderMatch =
      url.pathname.match(
        /^\/api\/orders\/(\d+)\/close$/
      );

    if (
      closeOrderMatch &&
      request.method === "POST"
    ) {
      try {
        const orderId =
          Number(closeOrderMatch[1]);

        const body =
          await request.json().catch(() => ({}));

        const paymentMethod =
          body.payment_method ??
          body.paymentMethod ??
          null;

        const paymentStatus =
          body.payment_status ??
          body.paymentStatus ??
          "paid";

        const order =
          await env.DB
            .prepare(`
              SELECT
                id,
                table_number,
                order_type
              FROM orders
              WHERE id = ?
            `)
            .bind(orderId)
            .first();

        if (!order) {
          return errorResponse(
            "Order not found",
            404
          );
        }

        await env.DB
          .prepare(`
            UPDATE orders
            SET
              payment_method = ?,
              payment_status = ?,
              order_status = 'completed',
              updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `)
          .bind(
            paymentMethod,
            paymentStatus,
            orderId
          )
          .run();

        // ------------------------------------------------------
        // Free the table
        // ------------------------------------------------------
        if (
          order.table_number !== null &&
          String(order.order_type).toLowerCase() === "dine-in"
        ) {
          await env.DB
            .prepare(`
              UPDATE restaurant_tables
              SET
                status = 'available',
                current_order_id = NULL,
                updated_at = CURRENT_TIMESTAMP
              WHERE table_number = ?
            `)
            .bind(
              String(order.table_number)
            )
            .run();
        }

        return json({
          success: true,
          message: "Order completed successfully",
          order_id: orderId
        });

      } catch (error) {
        return errorResponse(error.message);
      }
    }

    // ==========================================================
    // 11. EXPENSES - GET
    // ==========================================================
    if (
      url.pathname === "/api/expenses" &&
      request.method === "GET"
    ) {
      try {
        const limit = Math.min(
          Number(
            url.searchParams.get("limit")
          ) || 100,
          500
        );

        const { results } =
          await env.DB
            .prepare(`
              SELECT
                id,
                expense_date,
                category,
                description,
                amount,
                payment_method,
                created_at
              FROM expenses
              ORDER BY expense_date DESC, id DESC
              LIMIT ?
            `)
            .bind(limit)
            .all();

        return json({
          success: true,
          expenses: results || []
        });

      } catch (error) {
        return errorResponse(error.message);
      }
    }

    // ==========================================================
    // 12. EXPENSES - CREATE
    // ==========================================================
    if (
      url.pathname === "/api/expenses" &&
      request.method === "POST"
    ) {
      try {
        const body =
          await request.json();

        const expenseDate =
          body.expense_date ??
          body.expenseDate ??
          new Date().toISOString().slice(0, 10);

        const category =
          body.category ??
          "Other";

        const description =
          body.description ??
          "";

        const amount =
          Number(body.amount) || 0;

        const paymentMethod =
          body.payment_method ??
          body.paymentMethod ??
          null;

        if (amount <= 0) {
          return errorResponse(
            "Expense amount must be greater than 0",
            400
          );
        }

        const result =
          await env.DB
            .prepare(`
              INSERT INTO expenses
              (
                expense_date,
                category,
                description,
                amount,
                payment_method
              )
              VALUES (?, ?, ?, ?, ?)
            `)
            .bind(
              expenseDate,
              category,
              description,
              amount,
              paymentMethod
            )
            .run();

        return json({
          success: true,
          expense_id:
            result.meta?.last_row_id
        });

      } catch (error) {
        return errorResponse(error.message);
      }
    }

    // ==========================================================
    // 13. DASHBOARD
    // ==========================================================
    if (
      url.pathname === "/api/dashboard" &&
      request.method === "GET"
    ) {
      try {
        // ------------------------------------------------------
        // Today's sales
        // India local date approx using +05:30
        // ------------------------------------------------------
        const todaySales =
          await env.DB
            .prepare(`
              SELECT
                COALESCE(
                  SUM(grand_total),
                  0
                ) AS total_sales,
                COUNT(*) AS order_count
              FROM orders
              WHERE
                order_status = 'completed'
                AND date(
                  created_at,
                  '+5 hours',
                  '+30 minutes'
                ) =
                date(
                  'now',
                  '+5 hours',
                  '+30 minutes'
                )
            `)
            .first();

        // ------------------------------------------------------
        // Today's expenses
        // ------------------------------------------------------
        const todayExpenses =
          await env.DB
            .prepare(`
              SELECT
                COALESCE(
                  SUM(amount),
                  0
                ) AS total_expenses
              FROM expenses
              WHERE
                date(expense_date) =
                date(
                  'now',
                  '+5 hours',
                  '+30 minutes'
                )
            `)
            .first();

        // ------------------------------------------------------
        // Overall sales
        // ------------------------------------------------------
        const overallSales =
          await env.DB
            .prepare(`
              SELECT
                COALESCE(
                  SUM(grand_total),
                  0
                ) AS total_sales
              FROM orders
              WHERE order_status = 'completed'
            `)
            .first();

        // ------------------------------------------------------
        // Active tables
        // ------------------------------------------------------
        const tableSummary =
          await env.DB
            .prepare(`
              SELECT
                COUNT(*) AS total_tables,
                SUM(
                  CASE
                    WHEN status = 'occupied'
                    THEN 1
                    ELSE 0
                  END
                ) AS occupied_tables,
                SUM(
                  CASE
                    WHEN status = 'available'
                    THEN 1
                    ELSE 0
                  END
                ) AS available_tables
              FROM restaurant_tables
            `)
            .first();

        // ------------------------------------------------------
        // Expense breakdown
        // ------------------------------------------------------
        const { results: expenseBreakdown } =
          await env.DB
            .prepare(`
              SELECT
                category,
                COALESCE(
                  SUM(amount),
                  0
                ) AS amount
              FROM expenses
              GROUP BY category
              ORDER BY amount DESC
            `)
            .all();

        // ------------------------------------------------------
        // Recent orders
        // ------------------------------------------------------
        const { results: recentOrders } =
          await env.DB
            .prepare(`
              SELECT
                id,
                order_number,
                table_number,
                order_type,
                grand_total,
                payment_method,
                payment_status,
                order_status,
                created_at
              FROM orders
              ORDER BY id DESC
              LIMIT 10
            `)
            .all();

        // ------------------------------------------------------
        // Sales by day - last 14 days
        // ------------------------------------------------------
        const { results: salesTrend } =
          await env.DB
            .prepare(`
              SELECT
                date(
                  created_at,
                  '+5 hours',
                  '+30 minutes'
                ) AS sale_date,
                COALESCE(
                  SUM(grand_total),
                  0
                ) AS sales
              FROM orders
              WHERE
                order_status = 'completed'
                AND date(
                  created_at,
                  '+5 hours',
                  '+30 minutes'
                ) >= date(
                  'now',
                  '-13 days',
                  '+5 hours',
                  '+30 minutes'
                )
              GROUP BY sale_date
              ORDER BY sale_date
            `)
            .all();

        const sales =
          Number(todaySales?.total_sales) || 0;

        const expenses =
          Number(todayExpenses?.total_expenses) || 0;

        const netProfit =
          sales - expenses;

        const orderCount =
          Number(todaySales?.order_count) || 0;

        const averageOrder =
          orderCount > 0
            ? sales / orderCount
            : 0;

        return json({
          success: true,

          summary: {
            today_sales: sales,
            today_orders: orderCount,
            average_order: averageOrder,
            overall_sales:
              Number(
                overallSales?.total_sales
              ) || 0,
            today_expenses: expenses,
            net_profit: netProfit
          },

          tables: {
            total:
              Number(
                tableSummary?.total_tables
              ) || 0,
            occupied:
              Number(
                tableSummary?.occupied_tables
              ) || 0,
            available:
              Number(
                tableSummary?.available_tables
              ) || 0
          },

          expense_breakdown:
            expenseBreakdown || [],

          recent_orders:
            recentOrders || [],

          sales_trend:
            salesTrend || []
        });

      } catch (error) {
        return errorResponse(error.message);
      }
    }

    // ==========================================================
    // 14. HEALTH CHECK
    // ==========================================================
    if (
      url.pathname === "/api/health" &&
      request.method === "GET"
    ) {
      return json({
        success: true,
        application: "Viraasat POS 3.0",
        status: "online",
        database: "D1 connected"
      });
    }

    // ==========================================================
    // DEFAULT
    // ==========================================================
    return new Response(
      "Viraasat POS API is running",
      {
        status: 200,
        headers: {
          "Content-Type": "text/plain"
        }
      }
    );
  }
};
