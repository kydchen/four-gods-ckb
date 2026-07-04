# Four Gods on CKB

A remote-play web implementation of the *Encirclement of the Four Gods* gamble from the manga **Usogui** (噬谎者), running on Nervos CKB testnet.

- 2–6 players, rotating banker
- Commit/reveal directions on-chain
- Native CKB used as in-game BIOS chips
- Built with **Next.js + CCC + Rust/ckb-std**

## Structure

```
.
├── frontend/          # Next.js app
├── contracts/         # Rust CKB workspace
│   └── contracts/four-gods
└── scripts/           # Deployment helpers
```

## Development

### Frontend

```bash
cd frontend
pnpm install
pnpm dev
```

### Contract

```bash
cd contracts
make build
```

## Testnet deployment

Deploy the contract cell with CCC, then paste the printed `NEXT_PUBLIC_*` values into Vercel.

```bash
cd frontend
pnpm deploy:contract:dry-run
CKB_PRIVATE_KEY=0x... pnpm deploy:contract
```

By default the deploy script uses CKB testnet and an unspendable zero-lock for the contract cell, so wallet auto-selection cannot accidentally spend the deployed code cell while testing. Use `CKB_DEPLOY_LOCK=owner` only if you want the deployer wallet to keep control of the cell.

Vercel settings:

```text
Repository: kydchen/four-gods-ckb
Root Directory: frontend
Framework Preset: Next.js
Build Command: pnpm build
```

## License

MIT
