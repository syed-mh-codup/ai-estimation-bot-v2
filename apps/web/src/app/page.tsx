import { redirect } from 'next/navigation';

/**
 * The root has no content of its own. Signed in, the estimates list is the job;
 * signed out, /dashboard bounces to /login.
 */
export default function Home() {
  redirect('/dashboard');
}
