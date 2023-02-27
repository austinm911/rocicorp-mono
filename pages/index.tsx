import Head from 'next/head';
import styles from '@/styles/Home.module.css';
import Nav from '@/components/Nav/Nav';
import Benefits from '@/components/Benefits/Benefits';
import GetStarted from '@/components/GetStarted/GetStarted';
import Pricing from '@/components/Pricing/Pricing';
import Demo from '@/components/Demo/Demo';

export default function Home() {
  return (
    <div className={styles.container}>
      <Head>
        <title>Reflect</title>
        <meta name="description" content="Reflect" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/favicon.ico" />
      </Head>

      <Nav />

      <main className={styles.main}>
        <section
          id="intro"
          className={`${styles.section} ${styles.introSection}`}
        >
          <h1 className={styles.title}>The next web is </h1>
          <Demo />

          <p className={styles.featuredStatement}>
            Reflect is a web service and JavaScript library for building
            high-performance multiplayer web apps like Figma or Notion.
          </p>
        </section>

        <section id="benefits" className={styles.section}>
          <h2 className={styles.subheader}>Benefits</h2>
          <Benefits />
        </section>

        <section id="get-started" className={styles.section}>
          <h2 className={styles.subheader}>Join the Waitlist</h2>
          <GetStarted />
        </section>

        <section id="pricing" className={styles.section}>
          <h2 className={styles.subheader}>Pricing</h2>
          <Pricing />
        </section>
      </main>
    </div>
  );
}
