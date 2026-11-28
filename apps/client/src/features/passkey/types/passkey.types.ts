export interface IPasskey {
  id: string;
  name: string;
  deviceType: string;
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}
