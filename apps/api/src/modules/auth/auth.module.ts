import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
import { HoldingsModule } from '../holdings/holdings.module';
import { EmailCodeService } from './email-code.service';
import { EmailSenderService } from './email-sender.service';
import { GoogleAuthService } from './google-auth.service';
import { IdentitiesService } from './identities.service';
import { PasskeyService } from './passkey.service';
import { SignInMethodsController } from './sign-in-methods.controller';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('jwt.secret'),
        signOptions: { expiresIn: '7d' },
      }),
    }),
    HoldingsModule,
  ],
  controllers: [AuthController, SignInMethodsController],
  providers: [
    AuthService,
    JwtStrategy,
    EmailSenderService,
    EmailCodeService,
    GoogleAuthService,
    IdentitiesService,
    PasskeyService,
  ],
  exports: [AuthService, IdentitiesService],
})
export class AuthModule {}
