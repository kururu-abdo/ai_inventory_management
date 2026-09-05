import type { SupabaseClient } from "@supabase/supabase-js";
import type { SqlitePosRepository } from "../database/sqlite-pos.repository.js";

type SyncEntity = "products" | "sales_invoices" | "invoice_items";
const SYNC_ORDER: readonly SyncEntity[] = ["products", "sales_invoices", "invoice_items"];

export interface NetworkStatus {
  isOnline(): Promise<boolean>;
}

export class HttpNetworkStatus implements NetworkStatus {
  public constructor(private readonly healthUrl: string, private readonly fetchImpl: typeof fetch = fetch) {}

  public async isOnline(): Promise<boolean> {
    try {
      const signal = AbortSignal.timeout(5_000);
      const response = await this.fetchImpl(this.healthUrl, { method: "HEAD", signal });
      return response.ok || response.status === 401 || response.status === 404;
    } catch {
      return false;
    }
  }
}

export interface SyncRunResult {
  skippedOffline: boolean;
  pulled: number;
  pushed: number;
  errors: string[];
}

/**
 * Pull-before-push gives local LWW a chance to reject stale cloud records. The
 * Supabase trigger is a second, atomic LWW guard for concurrent writers.
 */
export class SupabaseSyncWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  public constructor(
    private readonly database: SqlitePosRepository,
    private readonly supabase: SupabaseClient,
    private readonly network: NetworkStatus,
    private readonly storeId: string,
  ) {}

  public start(intervalMs = 30_000): void {
    if (this.timer) return;
    void this.syncNow();
    this.timer = setInterval(() => void this.syncNow(), intervalMs);
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  public async syncNow(): Promise<SyncRunResult> {
    if (this.running) return { skippedOffline: false, pulled: 0, pushed: 0, errors: ["Sync already running"] };
    if (!(await this.network.isOnline())) return { skippedOffline: true, pulled: 0, pushed: 0, errors: [] };
    this.running = true;
    const result: SyncRunResult = { skippedOffline: false, pulled: 0, pushed: 0, errors: [] };
    try {
      for (const entity of SYNC_ORDER) result.pulled += await this.pull(entity);
      for (const entity of SYNC_ORDER) result.pushed += await this.push(entity);
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : "Unknown sync failure");
    } finally {
      this.running = false;
    }
    return result;
  }

  private async pull(entity: SyncEntity): Promise<number> {
    const lastPulledAt = this.database.lastPulledAt(entity);
    let query = this.supabase.from(entity).select("*").eq("store_id", this.storeId).order("updated_at", { ascending: true }).limit(500);
    if (lastPulledAt) query = query.gt("updated_at", lastPulledAt);
    const { data, error } = await query;
    if (error) throw new Error(`Supabase pull ${entity} failed: ${error.message}`);
    const records = data ?? [];
    if (records.length > 0) {
      this.database.applyRemote(entity, records);
      const latest = records.reduce((max: string, row: Record<string, unknown>) => String(row.updated_at) > max ? String(row.updated_at) : max, String(records[0]!.updated_at));
      this.database.setLastPulledAt(entity, latest);
    }
    return records.length;
  }

  private async push(entity: SyncEntity): Promise<number> {
    const local = this.database.pendingRows(entity, this.storeId);
    if (local.length === 0) return 0;
    const { data, error } = await this.supabase
      .from(entity)
      .upsert(local, { onConflict: "id" })
      .select("id,updated_at");
    if (error) throw new Error(`Supabase push ${entity} failed: ${error.message}`);

    const returned = new Map((data ?? []).map((row: Record<string, unknown>) => [String(row.id), String(row.updated_at)]));
    const acceptedIds = local
      .filter((row) => returned.get(String(row.id)) === String(row.updated_at))
      .map((row) => String(row.id));
    const expectedDates = new Map(local.map((row) => [String(row.id), String(row.updated_at)]));
    this.database.markSynced(entity, acceptedIds, expectedDates);
    return acceptedIds.length;
  }
}
