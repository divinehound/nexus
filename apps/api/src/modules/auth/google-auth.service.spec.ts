import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { jwtVerify } from 'jose';
import { GoogleAuthService } from './google-auth.service';
import { normalizeEmail } from './email-code.service';

jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(() => 'jwks'),
  jwtVerify: jest.fn(),
}));

const verify = jwtVerify as jest.Mock;

function service(clientId = 'client-123') {
  return new GoogleAuthService({ get: () => clientId } as any);
}

describe('GoogleAuthService', () => {
  beforeEach(() => verify.mockReset());

  it('checks the token against Google issuers and our client id', async () => {
    verify.mockResolvedValue({
      payload: { sub: 'g-1', email: 'Matt@Example.com', email_verified: true, name: 'Matt', picture: 'p' },
    });
    await expect(service().verifyCredential('token')).resolves.toEqual({
      sub: 'g-1',
      email: 'matt@example.com',
      name: 'Matt',
      picture: 'p',
    });
    expect(verify).toHaveBeenCalledWith('token', 'jwks', {
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: 'client-123',
    });
  });

  it('refuses an unverified email', async () => {
    verify.mockResolvedValue({ payload: { sub: 'g-1', email: 'a@b.co', email_verified: false } });
    await expect(service().verifyCredential('token')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuses a token that fails verification', async () => {
    verify.mockRejectedValue(new Error('bad signature'));
    await expect(service().verifyCredential('token')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('says Google sign-in is off without a client id', async () => {
    await expect(service('').verifyCredential('token')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(verify).not.toHaveBeenCalled();
  });
});

describe('normalizeEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmail('  Matt@Example.COM ')).toBe('matt@example.com');
  });

  it.each(['', 'nope', 'a@b', 'a b@c.de', 42, null])('rejects %p', (value) => {
    expect(() => normalizeEmail(value)).toThrow();
  });
});
