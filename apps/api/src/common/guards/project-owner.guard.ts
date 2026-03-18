import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { eq, and } from 'drizzle-orm';
import { DATABASE_TOKEN } from '../database/database.module';
import { type Database, projectOwners } from '@nexus/database';

/**
 * Guard that allows access if the user is an admin OR an owner/editor of the project.
 * Expects :projectId in route params.
 */
@Injectable()
export class ProjectOwnerGuard extends AuthGuard('jwt') implements CanActivate {
  constructor(@Inject(DATABASE_TOKEN) private readonly db: Database) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isAuthenticated = await super.canActivate(context);
    if (!isAuthenticated) return false;

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    // Admins always pass
    if (user?.role === 'admin') return true;

    const projectId = request.params.projectId;
    if (!projectId) {
      throw new ForbiddenException('Project ID required');
    }

    const ownership = await this.db.query.projectOwners.findFirst({
      where: and(
        eq(projectOwners.projectId, projectId),
        eq(projectOwners.userId, user.sub),
      ),
    });

    if (!ownership) {
      throw new ForbiddenException('You are not an owner of this project');
    }

    // Attach ownership role to request for further checks
    request.ownerRole = ownership.role;
    return true;
  }
}
