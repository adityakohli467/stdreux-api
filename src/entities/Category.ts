import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToMany,
  ManyToOne,
  OneToMany,
  JoinColumn,
  Index,
} from "typeorm"
import { Product } from "./Product"

@Entity("category")
@Index(["category_status"])
@Index(["parent_category_id"])
export class Category {
  @PrimaryGeneratedColumn()
  category_id!: number

  @Column({ type: "varchar", length: 255 })
  category_name!: string

  @Column({ type: "text", nullable: true })
  category_description!: string

  @Column({ type: "int", nullable: true })
  parent_category_id!: number

  @Column({ type: "int", default: 1 })
  category_status!: number

  @Column({ type: "int", default: 0 })
  sort_order!: number

  @Column({ type: "boolean", default: false })
  gst_free!: boolean

  @CreateDateColumn({ name: "category_date_added" })
  category_date_added!: Date

  @UpdateDateColumn({ name: "category_date_modified" })
  category_date_modified!: Date

  // Relations
  @ManyToMany(() => Product, (product) => product.categories)
  products!: Product[]

  @ManyToOne(() => Category, (category) => category.children)
  @JoinColumn({ name: "parent_category_id" })
  parent!: Category

  @OneToMany(() => Category, (category) => category.parent)
  children!: Category[]
}

