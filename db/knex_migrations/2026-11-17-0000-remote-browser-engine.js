exports.up = async (knex) => {
    await knex.schema.alterTable("remote_browser", (table) => {
        // chromium = Playwright connect(); kitesurf = Puppeteer CDP connect(browserWSEndpoint)
        table.string("engine", 32).notNullable().defaultTo("chromium");
    });
};

exports.down = async (knex) => {
    await knex.schema.alterTable("remote_browser", (table) => {
        table.dropColumn("engine");
    });
};
