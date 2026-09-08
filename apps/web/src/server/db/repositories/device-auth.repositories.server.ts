import type { PrismaClient } from "../../../../generated/client";
import type {
  DeviceAuthorizationRecord,
  DeviceAuthorizationStore,
} from "../../auth/device-auth.server";

const recordShape = {
  id: true,
  userId: true,
  status: true,
  expiresAt: true,
  lastPolledAt: true,
} as const;

export class PrismaDeviceAuthorizationStore implements DeviceAuthorizationStore {
  constructor(private readonly db: PrismaClient) {}

  create(input: { deviceCodeHash: string; userCodeHash: string; expiresAt: Date }) {
    return this.db.deviceAuthorization.create({ data: input, select: recordShape });
  }

  findByDeviceCodeHash(hash: string): Promise<DeviceAuthorizationRecord | null> {
    return this.db.deviceAuthorization.findUnique({
      where: { deviceCodeHash: hash },
      select: recordShape,
    });
  }

  findByUserCodeHash(hash: string): Promise<DeviceAuthorizationRecord | null> {
    return this.db.deviceAuthorization.findUnique({
      where: { userCodeHash: hash },
      select: recordShape,
    });
  }

  async markPolled(id: string, at: Date): Promise<void> {
    await this.db.deviceAuthorization.update({ where: { id }, data: { lastPolledAt: at } });
  }

  async approve(id: string, userId: string, at: Date): Promise<void> {
    // Conditional on the row still being pending, so two browser tabs racing on the same code
    // cannot rebind an already-approved grant to a second user.
    await this.db.deviceAuthorization.updateMany({
      where: { id, status: "pending" },
      data: { status: "approved", userId, approvedAt: at },
    });
  }

  async deny(id: string): Promise<void> {
    await this.db.deviceAuthorization.updateMany({
      where: { id, status: "pending" },
      data: { status: "denied" },
    });
  }

  async consume(id: string): Promise<void> {
    await this.db.deviceAuthorization.updateMany({
      where: { id, status: "approved" },
      data: { status: "consumed" },
    });
  }
}
