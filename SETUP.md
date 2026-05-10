# swiss-shopping-mcp - Setup Instructions

## ✅ Project Scaffold Complete!

Your **swiss-shopping-mcp** project has been initialized with:

### Project Structure
```
swiss-shopping-mcp/
├── .claude/                 # Copilot context & planning
│   ├── claude.md           # Development context
│   ├── PLAN.md             # Detailed roadmap
│   └── .mcp.json           # MCP configuration
├── src/
│   ├── adapters/           # Chain-specific adapters (Migros, Coop, etc.)
│   │   └── types.ts        # Common type definitions
│   ├── services/           # Business logic (matcher, planner, strategy)
│   ├── tools/              # MCP tool handlers
│   ├── util/               # Utilities (logging, HTTP, geocoding)
│   └── index.ts            # MCP server entry point
├── package.json            # pnpm configuration
├── tsconfig.json          # TypeScript config (strict mode)
├── vitest.config.ts       # Test framework config
├── .eslintrc.json         # ESLint rules
├── .prettierrc.json       # Code formatting
├── README.md              # Project documentation
└── .gitignore             # Git ignore patterns
```

### Technologies
- **Language**: TypeScript (strict mode)
- **Package Manager**: pnpm
- **Runtime**: Node.js 18+
- **Testing**: Vitest
- **Linting**: ESLint + Prettier
- **MCP**: @modelcontextprotocol/sdk
- **License**: MIT (most open compatible)

### Next Steps

#### 1. Create GitHub Repository
You need to create the repo on GitHub manually:
```bash
# Option A: Using GitHub Web UI
1. Go to https://github.com/new
2. Repository name: swiss-shopping-mcp
3. Select "Private"
4. Don't initialize with README/license (we have them)
5. Click "Create repository"

# Option B: Using GitHub CLI (if installed)
gh repo create swiss-shopping-mcp --private --source=. --remote=origin --push
```

#### 2. Add Remote and Push
```bash
cd C:\Users\xursc\projects\swiss-shopping-mcp
git remote add origin https://github.com/[YOUR_USERNAME]/swiss-shopping-mcp.git
git branch -M main
git push -u origin main
```

#### 3. Install Dependencies
```bash
cd C:\Users\xursc\projects\swiss-shopping-mcp
pnpm install
```

#### 4. Build & Test
```bash
pnpm build      # Compile TypeScript
pnpm test       # Run tests (should pass with logger tests)
pnpm lint       # Check code quality
```

#### 5. Verify Setup
```bash
pnpm dev        # Should start MCP server
# Press Ctrl+C to exit
```

---

## 📋 Development Phases

### Phase 1: V1 - Enhanced swissgroceries-mcp (Current)
- Copy adapters from swissgroceries-mcp
- Improve with better nutrition/allergen handling
- Implement services (matcher, planner, strategy)
- Create MCP tools (search, plan, find stores, etc.)
- Target: 80%+ test coverage

### Phase 2: V2 - Account Integration
- Add authentication for Migros, Coop, Denner, Lidl
- Implement basket/order management
- Loyalty program integration
- Graceful fallback to anonymous mode

### Phase 3: V3+ - Expansion
- Support non-grocery stores (pharma, hardware)
- Price history tracking
- Meal planning integration
- Sustainability features

See `.claude/PLAN.md` for detailed roadmap.

---

## 🚀 Quick Start

### Build the Project
```bash
cd C:\Users\xursc\projects\swiss-shopping-mcp
pnpm install
pnpm build
```

### Run Tests
```bash
pnpm test           # Run all tests
pnpm test:ui        # Interactive test UI
pnpm test:coverage  # Coverage report
```

### Development
```bash
pnpm watch          # TypeScript watch mode
pnpm format         # Auto-format code
pnpm lint          # Check for issues
```

---

## 📚 Key Files to Know

| File | Purpose |
|------|---------|
| `.claude/claude.md` | Development context & architecture notes |
| `.claude/PLAN.md` | Detailed roadmap with success criteria |
| `.claude/.mcp.json` | MCP server configuration |
| `src/index.ts` | Main MCP server bootstrap |
| `src/adapters/types.ts` | Common types for all adapters |
| `package.json` | Dependencies & scripts |
| `vitest.config.ts` | Test framework setup |

---

## 🔧 Configuration

### Environment Variables
- `LOG_LEVEL` - Set to `debug`, `info`, `warn`, or `error` (default: `info`)

### MCP Server Config
The MCP server is configured in `.claude/.mcp.json` and runs on stdio transport.

To use in Claude Desktop or other MCP clients, update your client's config:
```json
{
  "mcpServers": {
    "swiss-shopping-mcp": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "C:\\Users\\xursc\\projects\\swiss-shopping-mcp",
      "env": {
        "LOG_LEVEL": "info"
      }
    }
  }
}
```

---

## 📝 Development Workflow

1. **Create a feature branch**
   ```bash
   git checkout -b feature/my-feature
   ```

2. **Make changes with tests**
   - Edit code in `src/`
   - Add tests in `*.test.ts` files
   - Run `pnpm test` to verify

3. **Format and lint**
   ```bash
   pnpm format
   pnpm lint
   ```

4. **Commit and push**
   ```bash
   git add .
   git commit -m "feat: add my feature"
   git push origin feature/my-feature
   ```

5. **Create pull request on GitHub**

---

## ⚠️ Important Notes

- All code must be TypeScript with strict mode enabled
- Tests required for new features (target 80%+ coverage)
- Follow prettier/eslint rules (run `pnpm format` before commit)
- Use descriptive commit messages
- Check `.claude/PLAN.md` before starting new work

---

## 🆘 Troubleshooting

### pnpm not found
Install with: `npm install -g pnpm`

### Tests failing
```bash
pnpm install  # Reinstall dependencies
pnpm build    # Rebuild TypeScript
pnpm test     # Run tests
```

### Git remote not working
Make sure to create the GitHub repo first, then:
```bash
git remote remove origin
git remote add origin https://github.com/[YOUR_USERNAME]/swiss-shopping-mcp.git
git push -u origin main
```

---

## 📞 Support

Refer to:
- `.claude/claude.md` - Architecture & development notes
- `.claude/PLAN.md` - Detailed roadmap
- `README.md` - User-facing documentation
- `package.json` - Available scripts

---

**Ready to build! 🚀**
