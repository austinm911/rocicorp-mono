// components/Nav/Nav.tsx

import React, {Component} from 'react';
import NavLogo from './NavLogo';
import styles from './Nav.module.css';
import MobileNav from './MobileNav';
import {Link} from 'react-scroll';

export default class Nav extends Component {
  state = {
    showNavBorder: false,
  };

  listenToScrollEvent = () => {
    document.addEventListener('scroll', () => {
      requestAnimationFrame(() => {
        this.setState({
          showNavBorder: window.pageYOffset > 0,
        });
      });
    });
  };

  componentDidMount() {
    this.listenToScrollEvent();
  }

  navSepCalc = () => {
    return this.state.showNavBorder ? '0.1' : '0';
  };

  render() {
    return (
      <nav
        className={styles.nav}
        style={{
          borderBottom: '1px solid rgba(0, 0, 0, ' + this.navSepCalc() + ')',
        }}
      >
        <div className={styles.navContainer}>
          <Link
            href="#"
            className={styles.navLogoLinkMobile}
            to="intro"
            smooth={true}
            duration={250}
            isDynamic={true}
          >
            <NavLogo src="/reflect.svg" height="44" alt="Reflect logo" />
          </Link>
          <ul role="list" className={styles.navArray}>
            <li id="logo" className={styles.navLogoContainer}>
              <Link
                href="#"
                className={styles.navLogoLink}
                to="intro"
                smooth={true}
                duration={250}
                isDynamic={true}
              >
                <NavLogo src="/reflect.svg" height="44" alt="Reflect logo" />
              </Link>
            </li>
            <li></li>
            <li>
              <Link
                href="#"
                className={styles.navLink}
                activeClass={styles.navLinkActive}
                to="benefits"
                spy={true}
                hashSpy={true}
                smooth={true}
                duration={250}
                isDynamic={true}
              >
                Benefits
              </Link>
            </li>
            <li>
              <Link
                href="#"
                className={styles.navLink}
                activeClass={styles.navLinkActive}
                to="how"
                spy={true}
                hashSpy={true}
                smooth={true}
                isDynamic={true}
                duration={250}
              >
                How it works
              </Link>
            </li>
            <li>
              <Link
                href="#"
                className={styles.navLink}
                activeClass={styles.navLinkActive}
                to="pricing"
                spy={true}
                hashSpy={true}
                smooth={true}
                duration={250}
                isDynamic={true}
              >
                Pricing
              </Link>
            </li>
            <li>
              <Link
                href="#"
                className={styles.navLink}
                activeClass={styles.navLinkActive}
                to="customers"
                spy={true}
                hashSpy={true}
                isDynamic={true}
                smooth={true}
                duration={250}
              >
                Customers
              </Link>
            </li>
            <li>
              <Link
                href="#"
                className={styles.buttonPrimary}
                to="get-started"
                smooth={true}
                duration={250}
                spy={true}
                hashSpy={true}
                isDynamic={true}
              >
                Get started
              </Link>
            </li>
          </ul>
          <MobileNav />
        </div>
      </nav>
    );
  }
}
