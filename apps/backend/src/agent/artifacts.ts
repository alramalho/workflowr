import { randomUUID } from "crypto";
import { getArtifactFromDb } from "../db/artifacts.js";

export interface Artifact {
  content: Buffer;
  filename: string;
  mimeType: string;
}

export class ArtifactStore {
  private store = new Map<string, Artifact>();
  private recent: string[] = [];

  put(content: Buffer, filename: string, mimeType: string): string {
    const id = randomUUID().slice(0, 8);
    this.store.set(id, { content, filename, mimeType });
    this.recent.push(id);
    return id;
  }

  get(id: string): Artifact | undefined {
    const mem = this.store.get(id);
    if (mem) return mem;

    const persisted = getArtifactFromDb(id);
    if (persisted) {
      const artifact: Artifact = {
        content: Buffer.isBuffer(persisted.content) ? persisted.content : Buffer.from(persisted.content),
        filename: persisted.filename,
        mimeType: persisted.mime_type,
      };
      this.store.set(id, artifact);
      return artifact;
    }

    return undefined;
  }

  has(id: string): boolean {
    return this.store.has(id) || !!getArtifactFromDb(id);
  }

  popRecent(): string[] {
    const ids = [...this.recent];
    this.recent = [];
    return ids;
  }
}
