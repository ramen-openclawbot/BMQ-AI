import Image from "next/image";
import styles from "./page.module.css";

export default function Home() {
  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <Image
            src="/brand/logo.png"
            alt="Bánh Mì Que BMQ"
            width={140}
            height={60}
            priority
          />

          <nav className={styles.nav}>
            <a href="#products">Sản phẩm</a>
            <a href="#stores">Cửa hàng</a>
            <a href="#partner">Đối tác</a>
            <a href="#news">Tin tức</a>
            <a className={styles.cta} href="#contact">
              Đặt hàng ngay
            </a>
          </nav>
        </div>
      </header>

      <section className={styles.hero}>
        <div>
          <p className="kicker">Bánh Mì Que Pháp</p>
          <h1 className={styles.heroTitle}>
            BMQ — <span>Giòn</span> • Ngon • Chất lượng
          </h1>
          <p className={styles.lede}>
            Phong cách F&B premium: sạch, hiện đại, nhiều khoảng trắng. Bánh mì que
            giòn rụm, nhân pate béo bùi, vị cay nhẹ. Giao tận nơi — nhanh và nóng.
          </p>

          <div className={styles.heroActions}>
            <a className={styles.primaryBtn} href="#products">
              Xem menu
            </a>
            <a className={styles.secondaryBtn} href="#stores">
              Tìm cửa hàng
            </a>
          </div>

          <div className={styles.proofRow}>
            <div className={styles.proofItem}>
              <div className={styles.proofValue}>1900 555 591</div>
              <div className={styles.proofLabel}>Hotline</div>
            </div>
            <div className={styles.proofItem}>
              <div className={styles.proofValue}>Premium</div>
              <div className={styles.proofLabel}>Chuẩn vận hành</div>
            </div>
            <div className={styles.proofItem}>
              <div className={styles.proofValue}>Fresh</div>
              <div className={styles.proofLabel}>Nướng mới mỗi ngày</div>
            </div>
          </div>
        </div>

        <div>
          <Image
            src="/legacy/banhmique.com_attachment_2018_01_25_20180125050010187QQ.jpg"
            alt="Bánh mì que BMQ"
            width={760}
            height={520}
            className={styles.heroImg}
          />
        </div>
      </section>

      <section id="products" className={styles.section}>
        <h2>Sản phẩm nổi bật</h2>
        <p className={styles.muted}>
          Staging v02: đã áp dụng design system (green/orange + Inter/Playfair) theo
          spec của team Kimi. Danh mục sản phẩm sẽ map theo nội dung banhmique.com
          hiện tại.
        </p>
        <div className={styles.grid}>
          {[
            {
              title: "Bánh mì que pate",
              desc: "Vỏ giòn, nhân pate béo bùi — signature.",
            },
            {
              title: "Combo tiết kiệm",
              desc: "Phù hợp nhóm bạn/đặt theo set — giao nhanh.",
            },
            {
              title: "Đồ ăn vặt",
              desc: "Thêm lựa chọn cho bữa xế — nhẹ nhàng, tiện lợi.",
            },
          ].map((p) => (
            <div key={p.title} className={styles.card}>
              <div className={styles.cardTitle}>{p.title}</div>
              <div className={styles.cardDesc}>{p.desc}</div>
            </div>
          ))}
        </div>
      </section>

      <section id="stores" className={styles.sectionAlt}>
        <h2>Hệ thống cửa hàng</h2>
        <p className={styles.muted}>
          Sắp tới: trang store-locator (tỉnh/thành/quận) + CTA sticky trên mobile.
        </p>
      </section>

      <section id="partner" className={styles.section}>
        <h2>Trở thành đối tác</h2>
        <p className={styles.muted}>
          Mô hình vận hành chuẩn, hỗ trợ đào tạo và marketing. CTA dùng accent
          orange để tăng “appetite appeal”.
        </p>
      </section>

      <section id="news" className={styles.sectionAlt}>
        <h2>Tin tức & Khuyến mãi</h2>
        <p className={styles.muted}>
          Sắp tới: map danh sách bài viết (tin-tuc) + tối ưu SEO title/OG.
        </p>
      </section>

      <footer id="contact" className={styles.footer}>
        <div className={styles.footerInner}>
          <div>
            <div className={styles.footerTitle}>Bánh Mì Que BMQ</div>
            <div className={styles.muted}>Hotline: 1900 555 591</div>
          </div>
          <div className={styles.muted}>
            © {new Date().getFullYear()} BMQ. All rights reserved.
          </div>
        </div>
      </footer>
    </main>
  );
}
