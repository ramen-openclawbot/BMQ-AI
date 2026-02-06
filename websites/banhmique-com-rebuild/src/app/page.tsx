import Image from "next/image";
import styles from "./page.module.css";

export default function Home() {
  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <div className={styles.brand}>
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
            <a className={styles.cta} href="#contact">Liên hệ</a>
          </nav>
        </div>
      </header>

      <section className={styles.hero}>
        <div className={styles.heroContent}>
          <p className={styles.kicker}>Bánh Mì Que Pháp</p>
          <h1>BMQ — Giòn • Ngon • Chất lượng</h1>
          <p className={styles.lede}>
            Bánh mì que giòn rụm, nhân pate béo bùi, vị cay nhẹ kích thích vị giác.
            Giao tận nơi — nhanh, nóng, chuẩn vị.
          </p>
          <div className={styles.heroActions}>
            <a className={styles.primaryBtn} href="#products">Xem menu</a>
            <a className={styles.secondaryBtn} href="#stores">Tìm cửa hàng</a>
          </div>
          <div className={styles.proofRow}>
            <div className={styles.proofItem}>
              <div className={styles.proofValue}>1900 555 591</div>
              <div className={styles.proofLabel}>Hotline</div>
            </div>
            <div className={styles.proofItem}>
              <div className={styles.proofValue}>F&B</div>
              <div className={styles.proofLabel}>Chuẩn vận hành</div>
            </div>
            <div className={styles.proofItem}>
              <div className={styles.proofValue}>Fresh</div>
              <div className={styles.proofLabel}>Nướng mới mỗi ngày</div>
            </div>
          </div>
        </div>

        <div className={styles.heroVisual}>
          {/* Using legacy image copied from current site crawl (placeholder for curated hero) */}
          <Image
            src="/legacy/banhmique.com_attachment_2018_01_25_20180125050010187QQ.jpg"
            alt="Bánh mì que BMQ"
            width={720}
            height={480}
            className={styles.heroImg}
          />
        </div>
      </section>

      <section id="products" className={styles.section}>
        <h2>Sản phẩm nổi bật</h2>
        <p className={styles.muted}>
          Đây là bản dựng staging để review UI/UX. Danh sách sản phẩm sẽ được đồng bộ theo nội dung hiện tại của banhmique.com.
        </p>
        <div className={styles.grid}>
          {[
            {
              title: "Bánh mì que pate",
              desc: "Vỏ giòn, nhân pate béo bùi.",
            },
            {
              title: "Combo tiết kiệm",
              desc: "Phù hợp nhóm bạn/đặt theo set.",
            },
            {
              title: "Đồ ăn vặt",
              desc: "Thêm lựa chọn cho bữa xế.",
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
          Staging: sẽ bổ sung trang store-locator (tỉnh/thành/quận) theo dữ liệu hiện có.
        </p>
      </section>

      <section id="partner" className={styles.section}>
        <h2>Trở thành đối tác</h2>
        <p className={styles.muted}>
          Mở rộng cùng BMQ với mô hình vận hành chuẩn, hỗ trợ đào tạo và marketing.
        </p>
      </section>

      <section id="news" className={styles.sectionAlt}>
        <h2>Tin tức & Khuyến mãi</h2>
        <p className={styles.muted}>
          Staging: sẽ map sang danh sách bài viết hiện tại (tin-tuc) và tối ưu SEO.
        </p>
      </section>

      <footer id="contact" className={styles.footer}>
        <div className={styles.footerInner}>
          <div>
            <div className={styles.footerTitle}>Bánh Mì Que BMQ</div>
            <div className={styles.muted}>Hotline: 1900 555 591</div>
          </div>
          <div className={styles.muted}>© {new Date().getFullYear()} BMQ. All rights reserved.</div>
        </div>
      </footer>
    </main>
  );
}
