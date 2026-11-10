import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export type LocalReceipt = {
  id: string;
  receipt_no: string;
  data: Record<string, unknown>;
  amount_paise: number;
  created_at: string;
};

export type LocalPrintJob = {
  id: string;
  receipt_id: string;
  status: "PENDING" | "PRINTING" | "SUCCESS" | "FAILED" | "CANCELLED";
  idempotency_key: string;
  payload: string; // base64
  attempts: number;
  is_reprint: boolean;
  target: string;
  error: string | null;
  created_at: string;
  updated_at: string;
};

export type LocalAgentStatus = {
  id: "only";
  last_seen: string;
  printer_connected: boolean;
  port: string | null;
  note: string | null;
};

type StoreData = {
  sequence: number;
  receipts: LocalReceipt[];
  print_jobs: LocalPrintJob[];
  agent_status: LocalAgentStatus;
};

const DATA_DIR = path.join(process.cwd(), "data");
const DATA_FILE = path.join(DATA_DIR, "pos-local-data.json");

function initialData(): StoreData {
  return {
    sequence: 12,
    receipts: [],
    print_jobs: [],
    agent_status: {
      id: "only",
      last_seen: new Date().toISOString(),
      printer_connected: true,
      port: "POS-58-Series (1) (USB)",
      note: null,
    },
  };
}

let memoryStore: StoreData | null = null;

function loadStore(): StoreData {
  if (memoryStore) return memoryStore;
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, "utf8");
      memoryStore = JSON.parse(raw);
      return memoryStore!;
    }
  } catch (e) {
    console.error("Could not read local DB file, initializing fresh store:", e);
  }
  memoryStore = initialData();
  saveStore();
  return memoryStore;
}

function saveStore(): void {
  if (!memoryStore) return;
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(DATA_FILE, JSON.stringify(memoryStore, null, 2), "utf8");
  } catch (e) {
    console.error("Could not write to local DB file:", e);
  }
}

export const localDb = {
  getAgentStatus(): LocalAgentStatus {
    const store = loadStore();
    return store.agent_status;
  },

  updateAgentStatus(status: Partial<LocalAgentStatus>): LocalAgentStatus {
    const store = loadStore();
    store.agent_status = {
      ...store.agent_status,
      ...status,
      last_seen: status.last_seen ?? new Date().toISOString(),
    };
    saveStore();
    return store.agent_status;
  },

  getLatestReceipt(): LocalReceipt | null {
    const store = loadStore();
    if (store.receipts.length === 0) return null;
    return store.receipts[store.receipts.length - 1];
  },

  insertReceipt(params: {
    receipt_no?: string;
    data: Record<string, unknown>;
    amount_paise: number;
  }): LocalReceipt {
    const store = loadStore();
    let receiptNo = params.receipt_no;
    if (!receiptNo) {
      receiptNo = String(store.sequence).padStart(6, "0");
      store.sequence += 1;
    } else {
      const num = parseInt(receiptNo, 10);
      if (!isNaN(num) && num >= store.sequence) {
        store.sequence = num + 1;
      }
    }

    const receipt: LocalReceipt = {
      id: crypto.randomUUID(),
      receipt_no: receiptNo,
      data: params.data,
      amount_paise: params.amount_paise,
      created_at: new Date().toISOString(),
    };

    store.receipts.push(receipt);
    saveStore();
    return receipt;
  },

  deleteReceipt(id: string): void {
    const store = loadStore();
    store.receipts = store.receipts.filter((r) => r.id !== id);
    saveStore();
  },

  getJobByIdempotencyKey(key: string): (LocalPrintJob & { receipts?: { receipt_no: string } }) | null {
    const store = loadStore();
    const job = store.print_jobs.find((j) => j.idempotency_key === key);
    if (!job) return null;
    const receipt = store.receipts.find((r) => r.id === job.receipt_id);
    return {
      ...job,
      receipts: receipt ? { receipt_no: receipt.receipt_no } : undefined,
    };
  },

  insertPrintJob(params: {
    receipt_id: string;
    idempotency_key: string;
    payload: string;
    target: string;
    status: "PENDING" | "SUCCESS";
  }): LocalPrintJob {
    const store = loadStore();
    const job: LocalPrintJob = {
      id: crypto.randomUUID(),
      receipt_id: params.receipt_id,
      idempotency_key: params.idempotency_key,
      payload: params.payload,
      target: params.target,
      status: params.status,
      attempts: 0,
      is_reprint: false,
      error: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    store.print_jobs.push(job);
    saveStore();
    return job;
  },

  getJobById(id: string): LocalPrintJob | null {
    const store = loadStore();
    return store.print_jobs.find((j) => j.id === id) ?? null;
  },

  getPendingCount(): number {
    const store = loadStore();
    return store.print_jobs.filter((j) => j.status === "PENDING").length;
  },

  claimPrintJob(): LocalPrintJob | null {
    const store = loadStore();
    const job = store.print_jobs.find((j) => j.status === "PENDING");
    if (!job) return null;
    job.status = "PRINTING";
    job.attempts += 1;
    job.updated_at = new Date().toISOString();
    saveStore();
    return job;
  },

  finishPrintJob(id: string, status: "SUCCESS" | "FAILED", error?: string | null): LocalPrintJob | null {
    const store = loadStore();
    const job = store.print_jobs.find((j) => j.id === id);
    if (!job) return null;
    job.status = status;
    job.error = error ?? null;
    job.updated_at = new Date().toISOString();
    saveStore();
    return job;
  },
};

