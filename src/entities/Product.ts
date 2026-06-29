import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToMany,
  ManyToOne,
  OneToMany,
  JoinTable,
  JoinColumn,
  Index,
} from "typeorm"
import { Category } from "./Category"
import { ProductImage } from "./ProductImage"

@Entity("product")
@Index(["product_status"])
@Index(["user_id"])
@Index(["subcategory_id"])
@Index(["featured_1"])
@Index(["featured_2"])
export class Product {
  @PrimaryGeneratedColumn()
  product_id!: number

  @Column({ type: "varchar", length: 255 })
  product_name!: string

  @Column({ type: "varchar", length: 100, nullable: true })
  product_code!: string

  @Column({ type: "text", nullable: true })
  product_description!: string

  @Column({ type: "decimal", precision: 10, scale: 2 })
  product_price!: number

  @Column({ type: "int", default: 1 })
  product_status!: number

  @Column({ type: "int", nullable: true })
  product_quantity!: number

  @Column({ type: "varchar", length: 255, nullable: true, name: "product_image" })
  product_image_url!: string

  @Column({ type: "text", nullable: true })
  short_description!: string

  @Column({ type: "varchar", length: 50, nullable: true })
  roast_level!: string

  @Column({ type: "boolean", default: false })
  show_specifications!: boolean

  @Column({ type: "boolean", default: false })
  show_other_info!: boolean

  @Column({ type: "decimal", precision: 10, scale: 2, nullable: true })
  retail_price!: number

  @Column({ type: "decimal", precision: 5, scale: 2, nullable: true })
  retail_discount_percentage!: number

  @Column({ type: "decimal", precision: 10, scale: 2, nullable: true })
  user_price!: number

  @Column({ type: "decimal", precision: 5, scale: 2, nullable: true })
  premium_discount_percentage!: number

  @Column({ type: "decimal", precision: 10, scale: 2, nullable: true })
  product_price_premium!: number

  @Column({ type: "decimal", precision: 10, scale: 2, nullable: true })
  premium_price_discounted!: number

  @Column({ type: "varchar", length: 50, default: "all" })
  customer_type_visibility!: string

  @Column({ type: "int", nullable: true })
  user_id!: number

  @Column({ type: "int", nullable: true })
  subcategory_id!: number

  @Column({ type: "int", default: 1 })
  min_quantity!: number

  @Column({ type: "boolean", default: false })
  you_may_also_like!: boolean

  @Column({ type: "boolean", default: false })
  show_in_checkout!: boolean

  @Column({ type: "boolean", default: false })
  show_in_store!: boolean

  @Column({ type: "boolean", default: false })
  add_to_subscription!: boolean

  @Column({ type: "boolean", default: false })
  featured_1!: boolean

  @Column({ type: "boolean", default: false })
  featured_2!: boolean

  @Column({ type: "boolean", default: false })
  priority_access!: boolean

  @Column({ type: "date", nullable: true })
  priority_access_expiry!: Date

  @CreateDateColumn({ name: "product_date_added" })
  product_date_added!: Date

  @UpdateDateColumn({ name: "product_date_modified" })
  product_date_modified!: Date

  // Relations
  @ManyToMany(() => Category, (category) => category.products)
  @JoinTable({
    name: "product_category",
    joinColumn: { name: "product_id", referencedColumnName: "product_id" },
    inverseJoinColumn: { name: "category_id", referencedColumnName: "category_id" },
  })
  categories!: Category[]

  @ManyToOne(() => Category, { nullable: true })
  @JoinColumn({ name: "subcategory_id" })
  subcategory!: Category

  @OneToMany(() => ProductImage, (image) => image.product)
  images!: ProductImage[]
}

