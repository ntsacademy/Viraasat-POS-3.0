export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Test database connection
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
// Import menu items
if (url.pathname === "/api/menu/import" && request.method === "POST") {
  try {
    const data = await request.json();

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
      await env.DB
        .prepare(`
          INSERT INTO menu_items
          (name, category, price, gst_percent, is_available)
          VALUES (?, ?, ?, ?, ?)
        `)
        .bind(
          item.Item_Name,
          item.Category,
          Number(item.Price) || 0,
          0,
          1
        )
        .run();

      imported++;
    }

    return new Response(
      JSON.stringify({
        success: true,
        imported: imported
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
    // Get all menu items
    if (url.pathname === "/api/menu" && request.method === "GET") {
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

    return new Response("Viraasat POS API is running");
  }
};
