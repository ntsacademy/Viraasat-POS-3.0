export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ================================
    // TEST DATABASE CONNECTION
    // ================================
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


    // ================================
    // IMPORT MENU ITEMS
    // ================================
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

        const data = Array.isArray(body)
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
              error: "Menu data must be an array"
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
        let skipped = 0;
        const errors = [];

        // ================================
        // PROCESS EACH MENU ITEM
        // ================================
        for (let i = 0; i < data.length; i++) {
          const item = data[i];

          // Support different possible column names
          const name =
            item.Name ??
            item.name ??
            item.Item_Name ??
            item.item_name ??
            "";

          const category =
            item.Category ??
            item.category ??
            "";

          // Price can be:
          // 20
          // "20"
          // "₹20"
          // "₹ 20"
          const rawPrice =
            item.Price ??
            item.price ??
            0;

          const price = Number(
            String(rawPrice)
              .replace(/₹/g, "")
              .replace(/,/g, "")
              .trim()
          );

          // GST can be:
          // 0
          // "0%"
          // "5%"
          const rawGST =
            item["GST %"] ??
            item.GST ??
            item.gst_percent ??
            item.gst ??
            0;

          const gstPercent = Number(
            String(rawGST)
              .replace(/%/g, "")
              .trim()
          );

          // Available can be:
          // Yes / No
          // true / false
          // 1 / 0
          const rawAvailable =
            item.Available ??
            item.available ??
            item.is_available ??
            "Yes";

          const isAvailable =
            rawAvailable === true ||
            rawAvailable === 1 ||
            String(rawAvailable).toLowerCase().trim() === "yes" ||
            String(rawAvailable).toLowerCase().trim() === "true"
              ? 1
              : 0;


          // ================================
          // VALIDATION
          // ================================
          if (!name.trim()) {
            skipped++;

            errors.push({
              row: i + 1,
              error: "Menu name is missing"
            });

            continue;
          }

          if (!category.trim()) {
            skipped++;

            errors.push({
              row: i + 1,
              name: name,
              error: "Category is missing"
            });

            continue;
          }


          // ================================
          // INSERT INTO D1
          // ================================
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
              name.trim(),
              category.trim(),
              Number.isFinite(price) ? price : 0,
              Number.isFinite(gstPercent) ? gstPercent : 0,
              isAvailable
            )
            .run();

          imported++;
        }


        // ================================
        // IMPORT RESULT
        // ================================
        return new Response(
          JSON.stringify({
            success: true,
            imported: imported,
            skipped: skipped,
            total: data.length,
            errors: errors
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


    // ================================
    // GET ALL MENU ITEMS
    // ================================
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


    // ================================
    // DEFAULT RESPONSE
    // ================================
    return new Response(
      "Viraasat POS API is running"
    );
  }
};
