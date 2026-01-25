return {
  "neovim/nvim-lspconfig",
  opts = {
    servers = {
      denols = {
        root_dir = function(fname)
          return require("lspconfig.util").root_pattern("deno.json", "deno.jsonc")(fname)
        end,
      },
    },
  },
}
