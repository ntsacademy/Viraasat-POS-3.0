// Viraasat POS 3.0
// Cloudflare Worker + D1 Database API

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // =========================================================
    // 1. TEST DATABASE CONNECTION
    // =========================================================
    if (url.pathname === "/api/test-db") {
      try {
        const result = await env.DB
          .prepare("SELECT 1 AS ok")
          .first();

        return new Response(
          JSON.stringify({
            success: true,
            database: "connected",
            result
          }),
          {
            headers: {
              "Content-Type": "application/json"
            }
          }
        );
      } catch (error) {
        return new Response(
          JSON.stringify({
            success: false,
            error: error.message
          }),
          {
            status: 500,
            headers: {
              "Content-Type": "application/json"
            }
          }
        );
      }
    }


    // =========================================================
    // 2. IMPORT MENU ITEMS
    // =========================================================
    if (
      url.pathname === "/api/menu/import" &&
      request.method === "POST"
    ) {
      try {
        const body = await request.json();

        // Accept:
        // 1. Direct array
        // 2. { data: [...] }
        // 3. { items: [...] }

        const data =
          Array.isArray(body)
            ? body
            : Array.isArray(body.data)
              ? body.data
              : Array.isArray(body.items)
                ? body.items
                : null;

        if (!Array.isArray(data)) {
          return new Response(
            JSON.stringify({
              success: false,
              error: "Data must be an array"
            }),
            {
              status: 400,
              headers: {
                "Content-Type": "application/json"
              }
            }
          );
        }

        let imported = 0;

        for (const item of data) {

          // Support different column names
          const name =
            item.Item_Name ??
            item.item_name ??
            item.name ??
            item.Name ??
            "";

          const category =
            item.Category ??
            item.category ??
            "";

          const rawPrice =
            item.Price ??
            item.price ??
            0;

          const price =
            Number(
              String(rawPrice)
                .replace(/₹/g, "")
                .replace(/,/g, "")
                .trim()
            ) || 0;

          const rawGST =
            item.GST ??
            item.gst ??
            item.GST_Percent ??
            item.gst_percent ??
            0;

          const gst =
            Number(
              String(rawGST)
                .replace(/%/g, "")
                .trim()
            ) || 0;

          const availableValue =
            item.Available ??
            item.available ??
            item.Is_Available ??
            item.is_available ??
            "Yes";

          const isAvailable =
            String(availableValue)
              .toLowerCase()
              .trim() === "no"
              ? 0
              : 1;

          // Skip empty menu names
          if (!String(name).trim()) {
            continue;
          }

          await env.DB
            .prepare(`
              INSERT INTO menu_items
              (
                name,
                category,
                price,
                gst_percent,
                is_available
              )
              VALUES (?, ?, ?, ?, ?)
            `)
            .bind(
              String(name).trim(),
              String(category).trim(),
              price,
              gst,
              isAvailable
            )
            .run();

          imported++;
        }

        return new Response(
          JSON.stringify({
            success: true,
            imported
          }),
          {
            headers: {
              "Content-Type": "application/json"
            }
          }
        );

      } catch (error) {
        return new Response(
          JSON.stringify({
            success: false,
            error: error.message
          }),
          {
            status: 500,
            headers: {
              "Content-Type": "application/json"
            }
          }
        );
      }
    }


    // =========================================================
    // 3. GET ALL MENU ITEMS
    // =========================================================
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
              is_available
            FROM menu_items
            ORDER BY id
          `)
          .all();

        return new Response(
          JSON.stringify({
            success: true,
            items: results
          }),
          {
            headers: {
              "Content-Type": "application/json"
            }
          }
        );

      } catch (error) {
        return new Response(
          JSON.stringify({
            success: false,
            error: error.message
          }),
          {
            status: 500,
            headers: {
              "Content-Type": "application/json"
            }
          }
        );
      }
    }


    // =========================================================
    // 4. GET ALL RESTAURANT TABLES
    // =========================================================
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

        return new Response(
          JSON.stringify({
            success: true,
            tables: results
          }),
          {
            headers: {
              "Content-Type": "application/json"
            }
          }
        );

      } catch (error) {
        return new Response(
          JSON.stringify({
            success: false,
            error: error.message
          }),
          {
            status: 500,
            headers: {
              "Content-Type": "application/json"
            }
          }
        );
      }
    }


    // =========================================================
    // 5. UPDATE TABLE STATUS
    // =========================================================
    if (
      url.pathname === "/api/tables/status" &&
      request.method === "POST"
    ) {
      try {
        const body = await request.json();

        const tableNumber =
          body.table_number ??
          body.tableNumber ??
          body.table;

        const status =
          body.status ??
          "";

        // Validate table number
        if (
          tableNumber === undefined ||
          tableNumber === null ||
          String(tableNumber).trim() === ""
        ) {
          return new Response(
            JSON.stringify({
              success: false,
              error: "Table number is required"
            }),
            {
              status: 400,
              headers: {
                "Content-Type": "application/json"
              }
            }
          );
        }

        // Only these two statuses are allowed for now
        if (
          status !== "available" &&
          status !== "occupied"
        ) {
          return new Response(
            JSON.stringify({
              success: false,
              error: "Status must be available or occupied"
            }),
            {
              status: 400,
              headers: {
                "Content-Type": "application/json"
              }
            }
          );
        }

        const table =
          await env.DB
            .prepare(`
              SELECT id, table_number, status
              FROM restaurant_tables
              WHERE table_number = ?
            `)
            .bind(String(tableNumber))
            .first();

        if (!table) {
          return new Response(
            JSON.stringify({
              success: false,
              error: "Table not found"
            }),
            {
              status: 404,
              headers: {
                "Content-Type": "application/json"
              }
            }
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
            String(tableNumber)
          )
          .run();

        const updated =
          await env.DB
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
            .bind(String(tableNumber))
            .first();

        return new Response(
          JSON.stringify({
            success: true,
            table: updated
          }),
          {
            headers: {
              "Content-Type": "application/json"
            }
          }
        );

      } catch (error) {
        return new Response(
          JSON.stringify({
            success: false,
            error: error.message
          }),
          {
            status: 500,
            headers: {
              "Content-Type": "application/json"
            }
          }
        );
      }
    }


    // =========================================================
    // 6. DEFAULT RESPONSE
    // =========================================================
    return new Response(
      "Viraasat POS API is running",
      {
        headers: {
          "Content-Type": "text/plain"
        }
      }
    );
  }
};
