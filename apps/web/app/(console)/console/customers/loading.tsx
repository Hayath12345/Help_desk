import { CustomersSkeleton } from '@/components/console/customers/customers-skeleton';
import { ConsolePage } from '../_components/console-page';

export default function CustomersLoading() {
  return (
    <ConsolePage>
      <CustomersSkeleton />
    </ConsolePage>
  );
}
