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

## License

MIT
