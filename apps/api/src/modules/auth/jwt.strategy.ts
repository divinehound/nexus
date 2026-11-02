import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy, type StrategyOptionsWithoutRequest } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    const options: StrategyOptionsWithoutRequest = {
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('jwt.secret') || '',
    };
    super(options);
  }

  validate(payload: { sub: string; address?: string | null; role?: string }) {
    // address is null for users who signed in without a wallet and have none linked.
    return { sub: payload.sub, address: payload.address ?? null, role: payload.role || 'user' };
  }
}
