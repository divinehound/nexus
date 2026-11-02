import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Sends sign-in emails through Resend's HTTP API. */
@Injectable()
export class EmailSenderService {
  private readonly logger = new Logger(EmailSenderService.name);

  constructor(private readonly config: ConfigService) {}

  /** Whether codes can reach people (a key is set, or we're in development and log them). */
  isAvailable(): boolean {
    return !!this.apiKey() || process.env.NODE_ENV !== 'production';
  }

  async sendCode(to: string, code: string, purpose: 'sign_in' | 'link'): Promise<void> {
    const forLink = purpose === 'link';
    const subject = forLink
      ? `${code} adds this email to a Nexus account`
      : `${code} is your Nexus sign-in code`;
    const lead = forLink
      ? 'Someone asked to add this email address to their Nexus account. Enter this code only if that was you:'
      : 'Your Nexus sign-in code is';
    const warning = forLink
      ? 'Never share this code. Anyone who has it can sign in to their Nexus account with your email.'
      : 'It expires in 10 minutes. If you did not ask for it, you can ignore this email.';
    const text = [lead, '', code, '', warning].join('\n');
    const html = `<p>${lead}</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p><p>${warning}</p>`;

    const apiKey = this.apiKey();
    if (!apiKey) {
      if (process.env.NODE_ENV === 'production') {
        throw new ServiceUnavailableException('Email sign-in is not set up yet.');
      }
      this.logger.warn(`RESEND_API_KEY is not set. Sign-in code for ${to}: ${code}`);
      return;
    }

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: this.config.get<string>('auth.emailFrom'),
        to: [to],
        subject,
        text,
        html,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      this.logger.error(`Resend rejected the sign-in email (${res.status}): ${body.slice(0, 500)}`);
      throw new ServiceUnavailableException('Could not send the email. Try again in a minute.');
    }
  }

  private apiKey(): string {
    return this.config.get<string>('auth.resendApiKey') || '';
  }
}
