import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';

@Injectable()
export class WalletAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    // TODO: Implement SIWE / wallet signature verification
    return !!request.headers['x-wallet-address'];
  }
}
