import {
  TASK_PROTOCOL_MAJOR,
  decodeTaskRequest,
  encodeTaskResponse,
  type TaskCommand,
  type TaskPrincipal,
  type TaskResult,
} from "@coforge/protocol";
import type { CentrifugoRpcMethod } from "../centrifugo/rpc-handler.server";
import { isAppError } from "../../lib/app-error";

export function createAgentTaskMethod(
  taskBoard: {
    execute(principal: TaskPrincipal, command: TaskCommand): Promise<TaskResult>;
  },
  authorization: {
    computerIdForAuthorizedAgent(
      workspaceId: string,
      agentId: string,
      userId: string,
    ): Promise<string | undefined>;
  },
): CentrifugoRpcMethod {
  return async (payload, metadata) => {
    try {
      const request = decodeTaskRequest(payload);
      const principal = metadata.principal;
      const assignedComputerId = principal.agentId
        ? await authorization.computerIdForAuthorizedAgent(
            principal.workspaceId,
            principal.agentId,
            principal.userId,
          )
        : undefined;
      if (
        request.protocolMajor !== TASK_PROTOCOL_MAJOR ||
        !principal.agentId ||
        request.agentId !== principal.agentId ||
        request.workspaceId !== principal.workspaceId ||
        assignedComputerId !== principal.computerId
      )
        return { code: 403, message: "Task principal scope mismatch" };
      const {
        protocolMajor: _protocolMajor,
        workspaceId: _workspaceId,
        agentId: _agentId,
        ...command
      } = request;
      const result = await taskBoard.execute(
        { workspaceId: principal.workspaceId, agentId: principal.agentId },
        command,
      );
      return encodeTaskResponse({
        protocolMajor: TASK_PROTOCOL_MAJOR,
        requestId: request.requestId,
        ...result,
      });
    } catch (error) {
      if (isAppError(error)) {
        if (error.code === "CONFLICT")
          return { code: 400, message: "Task conflict; read the Task list again" };
        if (error.code === "NOT_FOUND") return { code: 400, message: "Task not found" };
        if (error.code === "ACCESS_DENIED") return { code: 403, message: "Task access denied" };
      }
      return { code: 400, message: "invalid Task request" };
    }
  };
}
