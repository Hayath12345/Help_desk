import { ReportsSkeleton } from '@/components/console/reports/reports-skeleton';
import { ConsolePage } from '../_components/console-page';

export default function ReportsLoading() {
  return (
    <ConsolePage>
      <ReportsSkeleton />
    </ConsolePage>
  );
}
