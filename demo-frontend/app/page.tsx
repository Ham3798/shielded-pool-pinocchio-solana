"use client";
import { useWalletConnection } from "@solana/react-hooks";
import { ShieldedPoolCard } from "./components/shielded-pool-card";

export default function Home() {
  const { connectors, connect, disconnect, wallet, status } =
    useWalletConnection();

  const address = wallet?.account.address.toString();

  return (
    <div className="relative min-h-screen overflow-x-clip bg-bg1 text-foreground">
      <main className="relative z-10 mx-auto flex min-h-screen max-w-4xl flex-col gap-10 border-x border-border-low px-6 py-16">
        <header className="space-y-3">
          <p className="text-sm uppercase tracking-[0.18em] text-muted">
            Solana Privacy Pool
          </p>
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">
            Auditable Dark Pool
          </h1>
          <p className="max-w-3xl text-base leading-relaxed text-muted">
            Privacy-preserving SOL transfers with{" "}
            <span className="font-semibold">compliance-first design</span>.
            Anonymous deposits and withdrawals, but identity can be recovered by
            2-of-3 designated auditors via RLWE threshold decryption.
          </p>
          <ul className="mt-4 space-y-2 text-sm text-foreground">
            <li className="flex gap-2">
              <span
                className="mt-1.5 h-2 w-2 rounded-full bg-foreground/60"
                aria-hidden
              />
              <div>
                <span className="font-medium">Auditable dark pool</span> — Private
                transfers with selective disclosure under authorized audit.
              </div>
            </li>
            <li className="flex gap-2">
              <span
                className="mt-1.5 h-2 w-2 rounded-full bg-foreground/60"
                aria-hidden
              />
              <div>
                <span className="font-medium">2-of-3 RLWE decryption</span> —
                Identity (wa_commitment) encrypted; only 2-of-3 auditors can
                jointly decrypt for compliance.
              </div>
            </li>
            <li className="flex gap-2">
              <span
                className="mt-1.5 h-2 w-2 rounded-full bg-foreground/60"
                aria-hidden
              />
              <div>
                <span className="font-medium">Noir ZK + Sunspot</span> — Withdrawal
                proofs verified on-chain via Groth16.
              </div>
            </li>
            <li className="flex gap-2">
              <span
                className="mt-1.5 h-2 w-2 rounded-full bg-foreground/60"
                aria-hidden
              />
              <div>
                <span className="font-medium">Compliance</span> — On-chain audit
                proof attestation; no single party has full decryption access.
              </div>
            </li>
          </ul>
        </header>

        <section className="w-full max-w-3xl space-y-4 rounded-2xl border border-border-low bg-card p-6 shadow-[0_20px_80px_-50px_rgba(0,0,0,0.35)]">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <p className="text-lg font-semibold">Wallet Connection</p>
              <p className="text-sm text-muted">
                Connect your Solana wallet to interact with the Shielded Pool on Devnet.
              </p>
            </div>
            <span className="rounded-full bg-cream px-3 py-1 text-xs font-semibold uppercase tracking-wide text-foreground/80">
              {status === "connected" ? "Connected" : "Not connected"}
            </span>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {connectors.map((connector) => (
              <button
                key={connector.id}
                onClick={() => connect(connector.id)}
                disabled={status === "connecting"}
                className="group flex items-center justify-between rounded-xl border border-border-low bg-card px-4 py-3 text-left text-sm font-medium transition hover:-translate-y-0.5 hover:shadow-sm cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
              >
                <span className="flex flex-col">
                  <span className="text-base">{connector.name}</span>
                  <span className="text-xs text-muted">
                    {status === "connecting"
                      ? "Connecting…"
                      : status === "connected" &&
                          wallet?.connector.id === connector.id
                        ? "Active"
                        : "Tap to connect"}
                  </span>
                </span>
                <span
                  aria-hidden
                  className="h-2.5 w-2.5 rounded-full bg-border-low transition group-hover:bg-primary/80"
                />
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-3 border-t border-border-low pt-4 text-sm">
            <span className="rounded-lg border border-border-low bg-cream px-3 py-2 font-mono text-xs">
              {address ?? "No wallet connected"}
            </span>
            <button
              onClick={() => disconnect()}
              disabled={status !== "connected"}
              className="inline-flex items-center gap-2 rounded-lg border border-border-low bg-card px-3 py-2 font-medium transition hover:-translate-y-0.5 hover:shadow-sm cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
            >
              Disconnect
            </button>
            <a
              href="https://faucet.solana.com/"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-lg border border-border-low bg-card px-3 py-2 font-medium transition hover:-translate-y-0.5 hover:shadow-sm"
            >
              Get Devnet SOL
            </a>
          </div>
        </section>

        {/* Shielded Pool Section */}
        <ShieldedPoolCard />

        {/* Technical Architecture */}
        <section className="w-full max-w-3xl space-y-4 rounded-2xl border border-border-low bg-card p-6 shadow-[0_20px_80px_-50px_rgba(0,0,0,0.35)]">
          <div className="space-y-1">
            <p className="text-lg font-semibold">Technical Architecture</p>
            <p className="text-sm text-muted">
              Noir · Sunspot · RLWE · Next
            </p>
          </div>

          <div className="space-y-3 text-sm">
            <div className="rounded-lg bg-cream/30 p-4">
              <p className="font-medium mb-2">Commitment Scheme</p>
              <code className="block text-xs bg-card p-2 rounded font-mono">
                {`(owner_x, owner_y) = secret_key * G  // BabyJubJub
wa_commitment = Poseidon(owner_x, owner_y)
commitment = Poseidon(owner_x, owner_y, amount, randomness)
nullifier = Poseidon(secret_key, leaf_index)`}
              </code>
            </div>

            <div className="rounded-lg bg-cream/30 p-4">
              <p className="font-medium mb-2">Program IDs (Devnet)</p>
              <div className="space-y-1 text-xs font-mono">
                <p>
                  <span className="text-muted">Pool:</span>{" "}
                  H76rmbsE6HxkDw7AWEJLtqYogyP6psq3Fk2wqPH7Cjes
                </p>
                <p>
                  <span className="text-muted">Verifier:</span>{" "}
                  3qfJCYMTnPwFgSX1T3Ncem6b5DphHtNoMmgyVeb52Yti
                </p>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-3 text-xs">
            <a
              href="https://github.com/Ham3798/auditable-dark-pool"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-md bg-cream px-2 py-1 font-medium transition hover:bg-cream/70"
            >
              GitHub Repository
            </a>
            <a
              href="https://noir-lang.org/"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-md bg-cream px-2 py-1 font-medium transition hover:bg-cream/70"
            >
              Noir Language
            </a>
            <a
              href="https://explorer.solana.com/address/H76rmbsE6HxkDw7AWEJLtqYogyP6psq3Fk2wqPH7Cjes?cluster=devnet"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-md bg-cream px-2 py-1 font-medium transition hover:bg-cream/70"
            >
              Explorer
            </a>
          </div>
        </section>

        {/* Footer */}
        <footer className="border-t border-border-low pt-6 text-center text-xs text-muted space-y-1">
          <p>Built for Solana Privacy Hackathon 2026</p>
          <p>
            <a href="https://x.com/ham379888" target="_blank" rel="noreferrer" className="font-medium underline underline-offset-2">@ham379888</a>
            {" · "}
            <a href="https://x.com/Scarrots93" target="_blank" rel="noreferrer" className="font-medium underline underline-offset-2">@Scarrots93</a>
            {" · "}
            <a href="https://t.me/Yunsikkkk" target="_blank" rel="noreferrer" className="font-medium underline underline-offset-2">TG @Yunsikkkk</a>
            {" · "}
            <a href="https://t.me/Scarrots" target="_blank" rel="noreferrer" className="font-medium underline underline-offset-2">TG @Scarrots</a>
          </p>
        </footer>
      </main>
    </div>
  );
}
