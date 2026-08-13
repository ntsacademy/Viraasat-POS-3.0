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
