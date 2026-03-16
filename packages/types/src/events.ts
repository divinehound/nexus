export enum EventType {
  SPACES = 'spaces',
  AMA = 'ama',
  MINT = 'mint',
  COLLAB = 'collab',
  IRL = 'irl',
  OTHER = 'other',
}

export enum EventStatus {
  UPCOMING = 'upcoming',
  LIVE = 'live',
  ENDED = 'ended',
}

export enum EventSource {
  AUTO_TWITTER = 'auto_twitter',
  MANUAL = 'manual',
  ON_CHAIN = 'on_chain',
}

export interface ProjectEvent {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  eventType: EventType;
  startTime: Date;
  endTime: Date | null;
  link: string | null;
  source: EventSource;
  twitterSpaceId: string | null;
  status: EventStatus;
  submittedBy: string | null;
  createdAt: Date;
}
