import { ForbiddenException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CompiledQuery,
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import WorkspaceAbilityFactory from '../../casl/abilities/workspace-ability.factory';
import { UpdateWorkspaceDto } from '../dto/update-workspace.dto';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { WorkspaceController } from './workspace.controller';
import { WorkspaceService } from '../services/workspace.service';

// The workspace switch for agent access (settings.agentMcp.enabled).
describe('agentMcpEnabled', () => {
  const workspace: any = { id: 'ws1', hostname: null };

  function controller() {
    const workspaceService = {
      update: jest.fn(async () => ({ ...workspace })),
    };
    const c = new WorkspaceController(
      workspaceService as any,
      {} as any,
      new WorkspaceAbilityFactory(),
      {} as any,
      {} as any,
      {} as any,
    );
    return { c, workspaceService };
  }

  it('a member cannot switch it', async () => {
    const { c, workspaceService } = controller();
    const dto = plainToInstance(UpdateWorkspaceDto, { agentMcpEnabled: true });
    await expect(
      c.updateWorkspace(
        {} as any,
        dto,
        { id: 'u1', role: 'member' } as any,
        workspace,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(workspaceService.update).not.toHaveBeenCalled();
  });

  it('an admin and an owner can', async () => {
    for (const role of ['admin', 'owner']) {
      const { c, workspaceService } = controller();
      const dto = plainToInstance(UpdateWorkspaceDto, {
        agentMcpEnabled: true,
      });
      await c.updateWorkspace(
        {} as any,
        dto,
        { id: 'u1', role } as any,
        workspace,
      );
      expect(workspaceService.update).toHaveBeenCalledWith(
        'ws1',
        expect.objectContaining({ agentMcpEnabled: true }),
      );
    }
  });

  it('the DTO takes a boolean only', async () => {
    const ok = plainToInstance(UpdateWorkspaceDto, { agentMcpEnabled: false });
    expect(await validate(ok)).toEqual([]);
    const bad = plainToInstance(UpdateWorkspaceDto, { agentMcpEnabled: 'yes' });
    expect((await validate(bad)).map((e) => e.property)).toEqual([
      'agentMcpEnabled',
    ]);
  });

  it('the repository writes settings.agentMcp.enabled and leaves other settings alone', async () => {
    const queries: CompiledQuery[] = [];
    const driver = new DummyDriver();
    driver.acquireConnection = async () =>
      ({
        executeQuery: async (q: CompiledQuery) => {
          queries.push(q);
          return { rows: [] };
        },
        streamQuery: async function* () {},
      }) as any;
    const db = new Kysely<any>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => driver,
        createIntrospector: (k) => new PostgresIntrospector(k),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
    });
    await new WorkspaceRepo(db as any).updateAgentMcpSettings(
      'ws1',
      'enabled',
      true,
    );
    expect(queries[0].sql).toMatch(
      /COALESCE\(settings, '\{\}'::jsonb\)\s+\|\| jsonb_build_object\('agentMcp', COALESCE\(settings->'agentMcp', '\{\}'::jsonb\)\s+\|\| jsonb_build_object\('enabled', true\)\)/,
    );
  });

  it('the service stores the switch as a setting, not as a workspace column', async () => {
    const workspaceRepo = {
      findById: jest.fn(async () => ({ id: 'ws1', settings: {} })),
      updateAgentMcpSettings: jest.fn(async () => undefined),
      updateWorkspace: jest.fn(async () => undefined),
    };
    const trx = {};
    const db = {
      transaction: () => ({ execute: (cb: any) => cb(trx) }),
    };
    const service = new (WorkspaceService as any)(
      workspaceRepo,
      ...Array(5).fill({}),
      { isBetaPublicSpaces: () => true, isCloud: () => false },
      ...Array(6).fill({}),
      db,
      {},
      {},
      {},
      { log: jest.fn() },
      {},
      {},
      {},
      {},
    );
    await service.update(
      'ws1',
      plainToInstance(UpdateWorkspaceDto, { agentMcpEnabled: true }),
    );
    expect(workspaceRepo.updateAgentMcpSettings).toHaveBeenCalledWith(
      'ws1',
      'enabled',
      true,
      trx,
    );
    const [columns] = workspaceRepo.updateWorkspace.mock.calls[0] as any[];
    expect(columns).not.toHaveProperty('agentMcpEnabled');
  });
});
