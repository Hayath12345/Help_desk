import { QueueSkeleton } from '@/components/console/queue/queue-skeleton';
import { ConsolePage } from '../_components/console-page';

export default function TeamQueueLoading() {
  return (
    <ConsolePage>
      <QueueSkeleton />
    </ConsolePage>
  );
}
