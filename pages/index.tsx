import Head from 'next/head';
import styles from '@/styles/Home.module.css';
import Nav from '@/components/Nav/Nav';
import Benefits from '@/components/Benefits/Benefits';
import How from '@/components/How/How';
import GetStarted from '@/components/GetStarted/GetStarted';
import Testimonials from '@/components/Testimonials/Testimonials';
import Pricing from '@/components/Pricing/Pricing';
import Demo from '@/components/Demo/Demo';
import Footer from '@/components/Footer/Footer';
import {useState} from 'react';
import {useDocumentSize} from '@/hooks/use-document-size';
import {useWindowSize} from '@/hooks/use-window-size';
import {useVHStyleProp} from '@/hooks/use-vh-style-prop';
import useIsomorphicLayoutEffect from '@/hooks/use-isomorphic-layout-effect';

export default function Home() {
  const winSize = useWindowSize();
  const docSize = useDocumentSize();
  useVHStyleProp(winSize?.height ?? null);
  const [gameMode, setGameMode] = useState<boolean>(false);

  useIsomorphicLayoutEffect(() => {
    document.documentElement.classList.toggle('game-mode', gameMode);
  }, [gameMode]);

  const onSetGameMode = (gameMode: boolean) => {
    setGameMode(gameMode);
  };

  return (
    <div className={styles.container}>
      <Head>
        <title>Reflect: High-performance sync for multiplayer web apps.</title>
        <meta
          name="description"
          content="60FPS sync, automatic persistence, server authority, optional offline, fine-grained auth, and more..."
        />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link
          rel="apple-touch-icon"
          sizes="180x180"
          href="/apple-touch-icon.png"
        />
        <link
          rel="icon"
          href="favicon.svg"
          type="image/svg+xml"
          media="(prefers-color-scheme: light)"
        />
        <link
          rel="icon"
          href="favicon-dm.svg"
          type="image/svg+xml"
          media="(prefers-color-scheme: dark)"
        />
        <link
          rel="icon"
          type="image/png"
          sizes="32x32"
          href="/favicon-32x32.png"
          media="(prefers-color-scheme: light)"
        />
        <link
          rel="icon"
          type="image/png"
          sizes="16x16"
          href="/favicon-16x16.png"
          media="(prefers-color-scheme: light)"
        />
        <link
          rel="icon"
          type="image/png"
          sizes="32x32"
          href="/favicon-32x32-dm.png"
          media="(prefers-color-scheme: dark)"
        />
        <link
          rel="icon"
          type="image/png"
          sizes="16x16"
          href="/favicon-16x16-dm.png"
          media="(prefers-color-scheme: dark)"
        />
        <link rel="manifest" href="/site.webmanifest" />

        {/* Facebook Meta Tags */}
        <meta property="og:url" content="https://reflect-net.vercel.app/" />
        <meta property="og:type" content="website" />
        <meta
          property="og:title"
          content="Reflect: High-performance sync for multiplayer web apps."
        />
        <meta
          property="og:description"
          content="60FPS sync, automatic persistence, server authority, optional offline, fine-grained auth, and more..."
        />
        <meta
          property="og:image"
          content="https://reflect-net.vercel.app/reflect-og.jpg"
        />

        {/* Twitter Meta Tags */}
        <meta name="twitter:card" content="summary_large_image" />
        <meta property="twitter:domain" content="reflect-net.vercel.app" />
        <meta
          property="twitter:url"
          content="https://reflect-net.vercel.app/"
        />
        <meta
          name="twitter:title"
          content="Reflect: High-performance sync for multiplayer web apps."
        />
        <meta
          name="twitter:description"
          content="60FPS sync, automatic persistence, server authority, optional offline, fine-grained auth, and more..."
        />
        <meta
          name="twitter:image"
          content="https://paint-fight.vercel.app/reflect-og.jpg"
        />
      </Head>

      <Nav gameMode={gameMode} />

      <main className={styles.main}>
        <Demo
          docSize={docSize}
          winSize={winSize}
          gameMode={gameMode}
          onSetGameMode={onSetGameMode}
        />

        <section id="benefits" className={styles.section}>
          <h2 className={styles.subheader}>Why Reflect?</h2>
          <Benefits />
        </section>

        <section id="how" className={styles.section}>
          <h2 className={styles.subheader}>How it Works</h2>
          <How />
        </section>

        <section id="pricing" className={styles.section}>
          <h2 className={styles.subheader}>Simple, Usage-Based Pricing</h2>
          <Pricing />
        </section>

        <section id="get-started" className={styles.section}>
          <h2 className={styles.subheader}>Coming Soon, from Rocicorp</h2>
          <GetStarted />
        </section>

        <section id="customers" className={styles.section}>
          <h2 className={styles.subheader}>Early Reactions</h2>
          <Testimonials />
        </section>
      </main>

      <Footer />
    </div>
  );
}
